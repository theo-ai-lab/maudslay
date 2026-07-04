/**
 * HearthDesk — SQLite backing store (node:sqlite, zero native deps).
 *
 * This module owns the schema and the query primitives. It holds no HTTP or
 * business-policy logic; server.ts composes these into the booking flow. The
 * DB is one of the two independent verification witnesses (the other is the
 * confirmation email) — so its shape is deliberately denormalized in the
 * /state snapshot to make field-by-field grading trivial and screen-free.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CustomerRow {
  id: number;
  name: string;
  phone: string;
  address: string;
}

export interface TechnicianRow {
  id: number;
  name: string;
  service_types_csv: string;
}

export interface SlotRow {
  id: number;
  tech_id: number;
  date: string;
  time: string;
  status: string; // open | held | booked
}

export interface BookingRow {
  ref: string;
  customer_id: number;
  tech_id: number;
  service_type: string;
  date: string;
  time: string;
  address: string;
  notes: string;
  status: string; // active | cancelled
  created_at: string;
}

/** A pending, not-yet-committed booking held between /review and /bookings. */
export interface PendingBooking {
  op: "create" | "reschedule";
  ref: string; // for reschedule this is the existing ref; for create it is assigned at commit
  customerId: number;
  customerName: string;
  phone: string;
  techId: number;
  serviceType: string;
  date: string;
  time: string;
  address: string;
  notes: string;
}

/**
 * Process-wide application state shared by the public server and the loopback
 * admin server, so a reset can atomically wipe transient in-memory booking
 * state alongside the durable DB.
 */
export interface AppState {
  db: DatabaseSync;
  dbPath: string;
  anchorDate: string; // "today" for slot/past-date logic (YYYY-MM-DD)
  seedName: string;
  /** >0 makes the current seed lag the durable commit behind the screen. */
  toastRaceMs: number;
  /** token -> pending booking (between review and confirm). */
  pending: Map<string, PendingBooking>;
  /** ref -> booking whose durable commit is deliberately lagging the screen. */
  committing: Map<string, PendingBooking>;
}

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}

/** Drop everything and recreate a clean schema. Called on every reset. */
export function resetSchema(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS bookings;
    DROP TABLE IF EXISTS slots;
    DROP TABLE IF EXISTS technicians;
    DROP TABLE IF EXISTS customers;
    DROP TABLE IF EXISTS meta;

    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL
    );

    CREATE TABLE technicians (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      service_types_csv TEXT NOT NULL
    );

    CREATE TABLE slots (
      id INTEGER PRIMARY KEY,
      tech_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE bookings (
      ref TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      tech_id INTEGER NOT NULL,
      service_type TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      address TEXT NOT NULL,
      notes TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );

    INSERT INTO meta (key, value) VALUES ('ref_seq', 200000);
  `);
}

/**
 * Allocate the next created-booking reference. Deterministic per reset: the
 * first created booking is always HD-200001, so goldens reproduce byte-stably.
 * Seeded (pre-existing) bookings use the HD-1xxxxx band and never collide.
 */
export function nextRef(db: DatabaseSync): string {
  db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'ref_seq'").run();
  const row = db.prepare("SELECT value FROM meta WHERE key = 'ref_seq'").get() as
    | { value: number }
    | undefined;
  const n = row ? row.value : 200001;
  return "HD-" + String(n);
}

export function insertCustomer(db: DatabaseSync, c: CustomerRow): void {
  db.prepare(
    "INSERT INTO customers (id, name, phone, address) VALUES (?, ?, ?, ?)",
  ).run(c.id, c.name, c.phone, c.address);
}

export function insertTechnician(db: DatabaseSync, t: TechnicianRow): void {
  db.prepare(
    "INSERT INTO technicians (id, name, service_types_csv) VALUES (?, ?, ?)",
  ).run(t.id, t.name, t.service_types_csv);
}

export function insertSlot(db: DatabaseSync, s: Omit<SlotRow, "id">): void {
  db.prepare(
    "INSERT INTO slots (tech_id, date, time, status) VALUES (?, ?, ?, ?)",
  ).run(s.tech_id, s.date, s.time, s.status);
}

export function insertBooking(db: DatabaseSync, b: BookingRow): void {
  db.prepare(
    `INSERT INTO bookings
       (ref, customer_id, tech_id, service_type, date, time, address, notes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    b.ref,
    b.customer_id,
    b.tech_id,
    b.service_type,
    b.date,
    b.time,
    b.address,
    b.notes,
    b.status,
    b.created_at,
    b.created_at, // updated_at starts equal to created_at
  );
}

/** ISO-8601 UTC "now" from SQLite, lexically comparable to caller ISO strings. */
function dbNow(db: DatabaseSync): string {
  const row = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS n").get() as {
    n: string;
  };
  return row.n;
}

export function getBooking(db: DatabaseSync, ref: string): BookingRow | undefined {
  return db.prepare("SELECT * FROM bookings WHERE ref = ?").get(ref) as
    | BookingRow
    | undefined;
}

export function setBookingStatus(
  db: DatabaseSync,
  ref: string,
  status: string,
): void {
  db.prepare("UPDATE bookings SET status = ?, updated_at = ? WHERE ref = ?").run(
    status,
    dbNow(db),
    ref,
  );
}

export function moveBooking(
  db: DatabaseSync,
  ref: string,
  date: string,
  time: string,
): void {
  db.prepare("UPDATE bookings SET date = ?, time = ?, updated_at = ? WHERE ref = ?").run(
    date,
    time,
    dbNow(db),
    ref,
  );
}

export function getCustomerById(
  db: DatabaseSync,
  id: number,
): CustomerRow | undefined {
  return db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as
    | CustomerRow
    | undefined;
}

/**
 * Resolve a customer by (case-insensitive, trimmed) name, optionally narrowed
 * by phone. Returns every match so the caller can decide: exactly one is
 * bookable, zero is "unknown customer", more than one with no phone is the
 * ambiguity trap.
 */
export function findCustomers(
  db: DatabaseSync,
  name: string,
  phone: string,
): CustomerRow[] {
  const wanted = name.trim().toLowerCase();
  const rows = db.prepare("SELECT * FROM customers").all() as unknown as CustomerRow[];
  let matches = rows.filter((r) => r.name.trim().toLowerCase() === wanted);
  const p = phone.trim();
  if (p.length > 0) {
    const digits = (s: string) => s.replace(/\D/g, "");
    matches = matches.filter((r) => digits(r.phone) === digits(p));
  }
  return matches;
}

export function getAllTechnicians(db: DatabaseSync): TechnicianRow[] {
  return db.prepare("SELECT * FROM technicians").all() as unknown as TechnicianRow[];
}

/** The technician who offers a given service type, if any. */
export function findTechForService(
  db: DatabaseSync,
  serviceType: string,
): TechnicianRow | undefined {
  const wanted = serviceType.trim().toLowerCase();
  const techs = getAllTechnicians(db);
  return techs.find((t) =>
    t.service_types_csv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .includes(wanted),
  );
}

export function getSlot(
  db: DatabaseSync,
  techId: number,
  date: string,
  time: string,
): SlotRow | undefined {
  return db
    .prepare("SELECT * FROM slots WHERE tech_id = ? AND date = ? AND time = ?")
    .get(techId, date, time) as SlotRow | undefined;
}

export function setSlotStatus(
  db: DatabaseSync,
  techId: number,
  date: string,
  time: string,
  status: string,
): void {
  db.prepare(
    "UPDATE slots SET status = ? WHERE tech_id = ? AND date = ? AND time = ?",
  ).run(status, techId, date, time);
}

/** Open times for a technician on a date, ascending — used to guide recovery. */
export function openTimes(
  db: DatabaseSync,
  techId: number,
  date: string,
): string[] {
  const rows = db
    .prepare(
      "SELECT time FROM slots WHERE tech_id = ? AND date = ? AND status = 'open' ORDER BY time",
    )
    .all(techId, date) as Array<{ time: string }>;
  return rows.map((r) => r.time);
}

/** Denormalized booking view whose keys mirror ExpectedBooking for the witness. */
export interface BookingWitness {
  ref: string;
  customerName: string;
  phone: string;
  serviceType: string;
  date: string;
  time: string;
  addressLine: string;
  notes: string;
  status: string;
  techId: number;
  createdAt: string;
  updatedAt: string;
}

export interface StateSnapshot {
  anchorDate: string;
  seed: string;
  bookings: BookingWitness[];
  slots: Array<{ techId: number; date: string; time: string; status: string }>;
}

/** The db witness: a screen-free JSON snapshot for the verifier. */
export function stateSnapshot(state: AppState): StateSnapshot {
  const db = state.db;
  const bookingRows = db
    .prepare(
      `SELECT b.ref, c.name AS customerName, c.phone AS phone,
              b.service_type AS serviceType, b.date, b.time,
              b.address AS addressLine, b.notes, b.status,
              b.tech_id AS techId, b.created_at AS createdAt,
              b.updated_at AS updatedAt
         FROM bookings b JOIN customers c ON c.id = b.customer_id
         ORDER BY b.ref`,
    )
    .all() as unknown as BookingWitness[];
  const slotRows = db
    .prepare(
      "SELECT tech_id AS techId, date, time, status FROM slots ORDER BY tech_id, date, time",
    )
    .all() as Array<{ techId: number; date: string; time: string; status: string }>;
  return {
    anchorDate: state.anchorDate,
    seed: state.seedName,
    bookings: bookingRows,
    slots: slotRows,
  };
}
