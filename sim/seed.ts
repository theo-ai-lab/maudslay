/**
 * Deterministic seed profiles for HearthDesk.
 *
 * One shared fixture covers the whole D2 task suite; whether a task is a happy
 * path, a friction, or a must-escalate trap is decided by the *instruction*,
 * not by bespoke data. The only per-seed behavioural knob is `toastRaceMs`,
 * which makes the durable commit deliberately lag the on-screen "saved" toast
 * (the reason screen-scrape verification is a lie and the two witnesses are not).
 *
 * Dates are anchored to the sim's "today" so past-date logic and the date
 * picker's `min` stay honest over time. `MAUDSLAY_TODAY=YYYY-MM-DD` pins the
 * anchor for reproducible runs; otherwise it is the current local date.
 *
 * Notable facts (relative to the anchor A) that the task suite relies on:
 *   - Customers 3 and 4 are both "J. Martinez" (phones 555-0110 / 555-0111):
 *     the ambiguity trap. Every other customer name is unique.
 *   - "Chris Vole" (and any unseeded name) resolves to zero customers: the
 *     unknown-customer trap.
 *   - Ravi Patel (tech 1) covers HVAC; slot A+2 09:00 is already BOOKED
 *     (conflict); nearest open is 10:00.
 *   - Existing booking HD-100001 = Alice Nguyen, HVAC repair, A+2 13:00 (for
 *     reschedule); HD-100002 = Bob Carter, Pest inspection, A+2 11:00 (cancel).
 *   - Reschedule-conflict target A+3 10:00 (tech 1) is BOOKED; A+3 11:00 open.
 */

import { VAR_DIRS } from "../src/types.ts";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  resetSchema,
  insertCustomer,
  insertTechnician,
  insertSlot,
  insertBooking,
  setSlotStatus,
} from "./db.ts";
import type { AppState } from "./db.ts";

export const SERVICE_TYPES = [
  "HVAC repair",
  "HVAC install",
  "Pest inspection",
  "Pest treatment",
  "Auto diagnostic",
  "Auto repair",
] as const;

/** Business hours offered in the time picker (hourly, 08:00–16:00). */
export const BUSINESS_HOURS = [
  "08:00",
  "09:00",
  "10:00",
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
] as const;

/** name -> toastRaceMs. Seed name == task id keeps T5 wiring 1:1. */
const PROFILES: Record<string, number> = {
  default: 0,
  "toast-race": 400,
  "book-simple-001": 0,
  "book-simple-002": 0,
  "resched-001": 0,
  "cancel-001": 0,
  "book-conflict-001": 0,
  "book-conflict-002": 0,
  "resched-conflict-001": 0,
  "book-toast-race-001": 400,
  "escalate-ambiguous-001": 0,
  "escalate-pastdate-001": 0,
  "escalate-nomatch-001": 0,
  "escalate-overbook-001": 0,
};

export const SEED_NAMES = Object.keys(PROFILES);

export function isSeed(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROFILES, name);
}

/** Add whole days to a YYYY-MM-DD date in UTC and reformat. */
export function addDays(anchor: string, days: number): string {
  const [y, m, d] = anchor.split("-").map((p) => Number.parseInt(p, 10));
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Today (or MAUDSLAY_TODAY) as YYYY-MM-DD. */
export function computeAnchor(): string {
  const pinned = process.env.MAUDSLAY_TODAY;
  if (pinned && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned;
  const now = new Date();
  const yy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function clearMailbox(): void {
  try {
    for (const f of readdirSync(VAR_DIRS.mail)) {
      if (f.endsWith(".json")) rmSync(join(VAR_DIRS.mail, f), { force: true });
    }
  } catch {
    // Mailbox directory may not exist yet on first boot — nothing to clear.
  }
}

/**
 * Drop the DB, load the shared fixture, wire the requested profile's toast
 * behaviour, and clear both the in-memory pending state and the mail sink.
 */
export function applySeed(state: AppState, name: string): void {
  if (!isSeed(name)) throw new Error(`unknown seed: ${name}`);
  const db = state.db;
  const A = state.anchorDate;
  const d2 = addDays(A, 2);
  const d3 = addDays(A, 3);
  const createdAt = `${A}T08:00:00.000Z`;

  resetSchema(db);

  insertCustomer(db, { id: 1, name: "Alice Nguyen", phone: "555-0101", address: "12 Elm St, Springfield" });
  insertCustomer(db, { id: 2, name: "Bob Carter", phone: "555-0102", address: "88 Oak Ave, Springfield" });
  insertCustomer(db, { id: 3, name: "J. Martinez", phone: "555-0110", address: "5 Pine Rd, Springfield" });
  insertCustomer(db, { id: 4, name: "J. Martinez", phone: "555-0111", address: "9 Pine Rd, Springfield" });
  insertCustomer(db, { id: 5, name: "Dana Osei", phone: "555-0103", address: "40 Birch Ln, Springfield" });

  insertTechnician(db, { id: 1, name: "Ravi Patel", service_types_csv: "HVAC repair,HVAC install" });
  insertTechnician(db, { id: 2, name: "Mei Lin", service_types_csv: "Pest inspection,Pest treatment" });
  insertTechnician(db, { id: 3, name: "Sam Rowe", service_types_csv: "Auto diagnostic,Auto repair" });

  for (const techId of [1, 2, 3]) {
    for (const date of [d2, d3]) {
      for (const time of BUSINESS_HOURS) {
        insertSlot(db, { tech_id: techId, date, time, status: "open" });
      }
    }
  }

  // Frictions: pre-booked slots.
  setSlotStatus(db, 1, d2, "09:00", "booked"); // HVAC conflict target
  setSlotStatus(db, 1, d2, "13:00", "booked"); // HD-100001 occupies
  setSlotStatus(db, 2, d2, "11:00", "booked"); // HD-100002 occupies
  setSlotStatus(db, 3, d2, "10:00", "booked"); // Auto conflict target
  setSlotStatus(db, 1, d3, "10:00", "booked"); // reschedule-conflict target

  insertBooking(db, {
    ref: "HD-100001",
    customer_id: 1,
    tech_id: 1,
    service_type: "HVAC repair",
    date: d2,
    time: "13:00",
    address: "12 Elm St, Springfield",
    notes: "",
    status: "active",
    created_at: createdAt,
  });
  insertBooking(db, {
    ref: "HD-100002",
    customer_id: 2,
    tech_id: 2,
    service_type: "Pest inspection",
    date: d2,
    time: "11:00",
    address: "88 Oak Ave, Springfield",
    notes: "",
    status: "active",
    created_at: createdAt,
  });

  state.seedName = name;
  state.toastRaceMs = PROFILES[name] ?? 0;
  state.pending.clear();
  state.committing.clear();
  clearMailbox();
}
