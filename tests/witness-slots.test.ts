/**
 * Witness completeness: slot occupancy.
 *
 * The sim's admin `GET /state` has always emitted every slot's status, but the
 * witness the verifier is given (`DbStateSnapshot`) carried only `bookings` —
 * so the slot table was read off the wire and thrown away. Nothing was
 * mis-graded by that: the sim commits the booking row and flips the slot to
 * `booked` as adjacent synchronous statements, and a follow-on create on a
 * taken slot is refused by `validateCreate` before it can reach a commit. This
 * file is therefore NOT a bug regression — it is an OBSERVABILITY lock. It
 * makes the invariant the verifier used to *assume* about the backend into
 * something the evidence actually *shows*, so a future change to the sim (or a
 * real backend adapter) cannot silently break it.
 *
 * Four things are pinned here:
 *
 *  1. the slot table survives normalization into the persisted witness;
 *  2. ABSENT is not EMPTY — a witness with no slot table (every trajectory
 *     recorded before this field existed) reports "not witnessed" rather than
 *     inventing "nothing is booked", and still audits;
 *  3. the invariant itself, over a seeded random walk of the REAL sim: in every
 *     witnessed state, an active booking's slot is booked and a cancelled
 *     booking's slot is free (unless another active booking now holds it);
 *  4. the checker is not vacuous — injecting a divergence into every witnessed
 *     state along that walk must be caught. A detector that always returns
 *     "clean" would pass (3) and prove nothing.
 *
 * Browser-free: the walk drives the sim with real HTML form POSTs over
 * node:http, exactly as tests/sim.test.ts does.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createState, startServer } from "../sim/server.ts";
import { startAdmin } from "../sim/admin.ts";
import { applySeed, addDays, BUSINESS_HOURS, SERVICE_TYPES } from "../sim/seed.ts";
import { createSmtpSink } from "../groundtruth/smtp-sink.ts";
import type { SmtpSinkHandle } from "../groundtruth/smtp-sink.ts";
import { normalizeSnapshot, slotOccupancyCheck, verify } from "../groundtruth/verifier.ts";
import { auditTrajectoryFile } from "../harness/audit.ts";
import { buildTasks } from "../harness/tasks.ts";
import type { AppState } from "../sim/db.ts";
import type {
  CapturedEmail,
  DbSlotRow,
  DbStateSnapshot,
  TrajectoryLine,
  WitnessSnapshot,
} from "../src/types.ts";
import { PORTS } from "../src/types.ts";

// Ports deliberately distinct from tests/sim.test.ts so a lingering listener
// from another file cannot make this one flake. The SMTP port is NOT free to
// choose: sim/mailer.ts targets PORTS.smtpSink, and a create commit that
// cannot reach a sink stalls the request.
const SIM_PORT = 4396;
const ADMIN_PORT = 4397;
const BASE = `http://127.0.0.1:${SIM_PORT}`;
const ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;
const ANCHOR = "2026-05-04";
const D2 = addDays(ANCHOR, 2);
const D3 = addDays(ANCHOR, 3);
const DB_PATH = "var/sim.slots.test.sqlite";
const MAIL_DIR = "var/mail-slots-test";

// ---------------------------------------------------------------------------
// HTTP plumbing (plain node:http, Connection: close — no browser)
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  location: string | undefined;
  body: string;
}

function req(
  method: string,
  urlStr: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const u = new URL(urlStr);
  return new Promise<Reply>((resolve, reject) => {
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { connection: "close", ...(opts.headers ?? {}) },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: data }),
        );
      },
    );
    r.on("error", reject);
    if (opts.body != null) r.write(opts.body);
    r.end();
  });
}

function postForm(urlStr: string, fields: Record<string, string>): Promise<Reply> {
  const body = new URLSearchParams(fields).toString();
  return req("POST", urlStr, {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
}

async function witnessedState(): Promise<DbStateSnapshot> {
  const r = await req("GET", `${ADMIN}/state`);
  return normalizeSnapshot(JSON.parse(r.body));
}

function tokenOf(loc: string | undefined): string | undefined {
  if (!loc) return undefined;
  const t = new URL(loc, BASE).searchParams.get("token");
  return t === null ? undefined : t;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same generator the repo's other seeded
// batteries use. A failure is reproducible from the seed alone.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)] as T;
}

// ---------------------------------------------------------------------------
// Sim lifecycle
// ---------------------------------------------------------------------------

let state: AppState;
let pub: Server;
let adm: Server;
let sink: SmtpSinkHandle;

before(async () => {
  rmSync(DB_PATH, { force: true });
  sink = createSmtpSink({ mailDir: MAIL_DIR });
  await sink.start();
  state = createState(DB_PATH, ANCHOR);
  applySeed(state, "book-simple-001");
  pub = await startServer(state, SIM_PORT);
  adm = await startAdmin(state, ADMIN_PORT);
});

after(async () => {
  pub.close();
  adm.close();
  await sink.stop();
  state.db.close();
  rmSync(DB_PATH, { force: true });
  rmSync(MAIL_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. The slot table survives into the witness
// ---------------------------------------------------------------------------

test("normalizeSnapshot carries the sim's slot table into the witness", async () => {
  const snap = await witnessedState();
  assert.ok(snap.slots !== undefined, "the witness must carry the slot table the sim emits");
  const slots = snap.slots as DbSlotRow[];
  assert.equal(slots.length, 54, "3 techs x 2 dates x 9 business hours");
  const booked = slots.find((s) => s.techId === 1 && s.date === D2 && s.time === "09:00");
  assert.deepEqual(booked, { techId: 1, date: D2, time: "09:00", status: "booked" });
  const open = slots.find((s) => s.techId === 1 && s.date === D2 && s.time === "10:00");
  assert.equal(open?.status, "open");
});

test("normalizeSnapshot accepts snake_case slot rows and drops uninterpretable ones", () => {
  const snap = normalizeSnapshot({
    bookings: [],
    slots: [
      { tech_id: "2", date: "2026-05-06", time: "11:00", status: "booked" },
      { techId: 3, date: "2026-05-06", time: "12:00", status: "open" },
      { techId: 3, date: "2026-05-06", status: "open" }, // no time — uninterpretable
      "nonsense",
    ],
  });
  assert.deepEqual(snap.slots, [
    { techId: 2, date: "2026-05-06", time: "11:00", status: "booked" },
    { techId: 3, date: "2026-05-06", time: "12:00", status: "open" },
  ]);
});

test("the booking row carries its technician so a slot can be attributed to it", async () => {
  const snap = await witnessedState();
  const seeded = snap.bookings.find((b) => b.ref === "HD-100001");
  assert.equal(seeded?.techId, 1, "HD-100001 is Ravi Patel's (tech 1) HVAC booking");
});

// ---------------------------------------------------------------------------
// 2. Absent is not empty — the backward-compatibility path
// ---------------------------------------------------------------------------

test("a payload with no slot table leaves `slots` ABSENT, never an empty table", () => {
  for (const raw of [null, {}, { bookings: [] }, { bookings: [], slots: "nope" }]) {
    const snap = normalizeSnapshot(raw);
    assert.equal(
      Object.hasOwn(snap, "slots"),
      false,
      `absence must not be materialized as a value: ${JSON.stringify(raw)}`,
    );
  }
  // A backend that genuinely reports zero slots is a DIFFERENT fact and is kept.
  const empty = normalizeSnapshot({ bookings: [], slots: [] });
  assert.deepEqual(empty.slots, []);
});

test("slotOccupancyCheck reports an unwitnessed slot table honestly instead of passing it", () => {
  const preSlots: DbStateSnapshot = {
    bookings: [{ ref: "HD-1", status: "active", techId: 1, date: D2, time: "09:00" }],
  };
  const check = slotOccupancyCheck(preSlots);
  assert.equal(check.witnessed, false, "no slot table was witnessed");
  assert.equal(check.checked, 0, "nothing may be reported as checked");
  assert.deepEqual(check.violations, [], "absence is not evidence of a violation either");
  assert.match(check.detail, /not witnessed/i);

  // The same rows WITH an empty slot table is a different, checkable fact.
  const emptyTable = slotOccupancyCheck({ ...preSlots, slots: [] });
  assert.equal(emptyTable.witnessed, true);
  assert.equal(emptyTable.violations.length, 1, "an active booking with no slot at all is a divergence");
  assert.equal(emptyTable.violations[0]?.kind, "active_booking_slot_missing");
});

test("a booking row with no technician is reported unchecked, not silently passed", () => {
  const check = slotOccupancyCheck({
    bookings: [{ ref: "HD-9", status: "active", date: D2, time: "09:00" }],
    slots: [{ techId: 1, date: D2, time: "09:00", status: "open" }],
  });
  assert.equal(check.witnessed, true);
  assert.equal(check.checked, 0);
  assert.equal(check.violations.length, 0);
  assert.equal(check.unchecked.length, 1);
  assert.equal(check.unchecked[0]?.ref, "HD-9");
});

test("a pre-slots trajectory still audits, and the absence is reported honestly", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-slots-"));
  try {
    const task = buildTasks(ANCHOR).find((t) => t.id === "book-simple-001");
    assert.ok(task && task.expectation.kind === "booking_created");
    if (!task || task.expectation.kind !== "booking_created") throw new Error("unreachable");
    const b = task.expectation.booking;
    const email: CapturedEmail = {
      id: "mail-HD-500001",
      from: "no-reply@hearthdesk.test",
      to: ["inbox@hearthdesk.test"],
      subject: "HearthDesk booking HD-500001 confirmed",
      bodyText: [
        "Reference: HD-500001",
        "Kind: created",
        `Customer: ${b.customerName}`,
        `Service: ${b.serviceType}`,
        `When: ${b.date} ${b.time}`,
        `Address: ${b.addressLine}`,
        "Notes: -",
      ].join("\n"),
      receivedAt: `${ANCHOR}T09:00:10.000Z`,
    };
    // Exactly the witness shape written before `slots` existed: bookings only.
    const witness: WitnessSnapshot = {
      anchor: ANCHOR,
      resetAt: `${ANCHOR}T09:00:00.000Z`,
      endReason: "done",
      expectation: task.expectation,
      emails: [email],
      db: {
        bookings: [
          {
            ref: "HD-500001",
            status: "active",
            customerName: b.customerName,
            phone: b.phone,
            serviceType: b.serviceType,
            date: b.date,
            time: b.time,
            addressLine: b.addressLine,
            createdAt: `${ANCHOR}T09:00:05.000Z`,
          },
        ],
      },
    };
    const verdict = verify({
      expectation: witness.expectation,
      endReason: witness.endReason,
      emails: witness.emails,
      db: witness.db,
      resetAt: witness.resetAt,
    });
    assert.equal(verdict.code, "OK", "guard: the fixture must genuinely earn OK");

    const lines: TrajectoryLine[] = [
      {
        t: "header",
        v: {
          taskId: "book-simple-001",
          seed: "book-simple-001",
          model: "stub",
          startedAt: `${ANCHOR}T09:00:00.000Z`,
          simVersion: "0.1.0",
          harnessVersion: "0.1.0",
        },
      },
      { t: "witness", v: witness },
      { t: "terminal", v: { endedAt: `${ANCHOR}T09:00:20.000Z`, endReason: "done", verdict } },
    ];
    const path = join(dir, "pre-slots.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const audit = auditTrajectoryFile(path);
    assert.equal(audit.status, "agree", audit.detail);
    assert.equal(audit.recomputed, "OK");
    // ...and the missing occupancy evidence is stated, not invented.
    assert.equal(slotOccupancyCheck(witness.db).witnessed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3 + 4. The invariant, over a seeded random walk of the real sim
// ---------------------------------------------------------------------------

const CUSTOMERS: Array<{ name: string; phone: string; address: string }> = [
  { name: "Alice Nguyen", phone: "555-0101", address: "12 Elm St, Springfield" },
  { name: "Bob Carter", phone: "555-0102", address: "88 Oak Ave, Springfield" },
  { name: "J. Martinez", phone: "555-0110", address: "5 Pine Rd, Springfield" },
  { name: "J. Martinez", phone: "", address: "9 Pine Rd, Springfield" }, // ambiguity trap
  { name: "Dana Osei", phone: "555-0103", address: "40 Birch Ln, Springfield" },
  { name: "Chris Vole", phone: "555-0199", address: "1 Nowhere Way" }, // unknown customer
];
const DATES = [D2, D3, addDays(ANCHOR, 4), addDays(ANCHOR, -1)]; // in-window, no-slots, past
const TIMES = [...BUSINESS_HOURS, "07:00"];
const SERVICES = [...SERVICE_TYPES, "Time travel"];

/** Every state this walk witnesses, in order. */
async function randomWalk(seedName: string, ops: number, rndSeed: number): Promise<DbStateSnapshot[]> {
  applySeed(state, seedName);
  const rnd = mulberry32(rndSeed);
  const seen: DbStateSnapshot[] = [await witnessedState()];

  for (let i = 0; i < ops; i++) {
    const roll = rnd();
    const before = seen[seen.length - 1] as DbStateSnapshot;
    const refs = before.bookings.map((b) => b.ref);

    if (roll < 0.55 || refs.length === 0) {
      const c = pick(rnd, CUSTOMERS);
      const review = await postForm(`${BASE}/new/review`, {
        customerName: c.name,
        phone: c.phone,
        serviceType: pick(rnd, SERVICES),
        date: pick(rnd, DATES),
        time: pick(rnd, TIMES),
        address: c.address,
        notes: rnd() < 0.3 ? "Gate code 4417" : "",
      });
      seen.push(await witnessedState());
      const token = tokenOf(review.location);
      if (token !== undefined) {
        await postForm(`${BASE}/bookings`, { token });
        seen.push(await witnessedState());
      }
    } else if (roll < 0.8) {
      const ref = pick(rnd, refs);
      const review = await postForm(`${BASE}/booking/${encodeURIComponent(ref)}/reschedule/review`, {
        date: pick(rnd, DATES),
        time: pick(rnd, TIMES),
      });
      seen.push(await witnessedState());
      const token = tokenOf(review.location);
      if (token !== undefined) {
        await postForm(`${BASE}/booking/${encodeURIComponent(ref)}/reschedule`, { token });
        seen.push(await witnessedState());
      }
    } else {
      const ref = pick(rnd, refs);
      await postForm(`${BASE}/booking/${encodeURIComponent(ref)}/cancel`, {});
      seen.push(await witnessedState());
    }
  }
  return seen;
}

function assertClean(states: DbStateSnapshot[], label: string): number {
  let rowsChecked = 0;
  states.forEach((s, i) => {
    const check = slotOccupancyCheck(s);
    assert.equal(check.witnessed, true, `${label} state ${i}: slot occupancy was not witnessed`);
    assert.deepEqual(
      check.violations,
      [],
      `${label} state ${i}: ${JSON.stringify(check.violations)}`,
    );
    rowsChecked += check.checked;
  });
  return rowsChecked;
}

test("invariant: every state witnessed along a seeded walk keeps bookings and slots agreed", async () => {
  const states = await randomWalk("book-simple-001", 90, 0xc0ffee);
  assert.ok(states.length >= 91, `expected a long walk, got ${states.length} states`);
  const rows = assertClean(states, "walk");
  // Guard against a vacuous pass: the walk must actually have booked things.
  assert.ok(rows >= 200, `expected the walk to check many booking rows, checked ${rows}`);
  const last = states[states.length - 1] as DbStateSnapshot;
  assert.ok(last.bookings.length > 2, "the walk must have created bookings beyond the two seeded ones");
  assert.ok(
    states.some((s) => s.bookings.some((b) => b.status === "cancelled")),
    "the walk must have exercised the cancelled-booking direction of the invariant",
  );
});

test("invariant: it holds at every sample DURING the toast-race commit lag", async () => {
  applySeed(state, "book-toast-race-001");
  const rnd = mulberry32(0x7a51);
  const sampled: DbStateSnapshot[] = [];
  for (let i = 0; i < 5; i++) {
    const c = pick(rnd, CUSTOMERS.slice(0, 3));
    const review = await postForm(`${BASE}/new/review`, {
      customerName: c.name,
      phone: c.phone,
      serviceType: "HVAC repair",
      date: pick(rnd, [D2, D3]),
      time: pick(rnd, BUSINESS_HOURS),
      address: c.address,
      notes: "",
    });
    const token = tokenOf(review.location);
    if (token === undefined) continue;
    await postForm(`${BASE}/bookings`, { token });
    // The row+slot land ~400ms after the screen says "saved". Sample straight
    // through that window: the toast lies, the witness must not.
    const deadline = Date.now() + 1200;
    let landed = 0;
    for (;;) {
      const s = await witnessedState();
      sampled.push(s);
      const n = s.bookings.length;
      if (n > landed) landed = n;
      if (Date.now() > deadline) break;
    }
  }
  assert.ok(sampled.length > 20, `expected many samples across the lag, got ${sampled.length}`);
  assertClean(sampled, "toast-race");
});

test("the checker is not vacuous: an injected divergence is caught in every witnessed state", async () => {
  const states = await randomWalk("book-simple-001", 40, 0x5eed);
  const rnd = mulberry32(0x5eed ^ 0xffff);
  let activeProbes = 0;
  let cancelledProbes = 0;

  for (const s of states) {
    const slots = s.slots as DbSlotRow[];
    const attributable = s.bookings.filter(
      (b) => b.techId !== undefined && b.date !== undefined && b.time !== undefined,
    );
    const key = (t: number, d: string, m: string) => `${t}|${d}|${m}`;
    const activeKeys = new Set(
      attributable
        .filter((b) => b.status === "active")
        .map((b) => key(b.techId as number, b.date as string, b.time as string)),
    );

    const actives = attributable.filter((b) => b.status === "active");
    if (actives.length > 0) {
      const b = pick(rnd, actives);
      const k = key(b.techId as number, b.date as string, b.time as string);
      // (a) free the slot underneath an active booking
      const freed: DbStateSnapshot = {
        bookings: s.bookings,
        slots: slots.map((x) => (key(x.techId, x.date, x.time) === k ? { ...x, status: "open" } : x)),
      };
      const freedCheck = slotOccupancyCheck(freed);
      assert.equal(freedCheck.violations.length, 1, `freeing ${b.ref}'s slot must be caught`);
      assert.equal(freedCheck.violations[0]?.kind, "active_booking_slot_not_booked");
      assert.equal(freedCheck.violations[0]?.ref, b.ref);

      // (b) delete the slot underneath an active booking
      const dropped: DbStateSnapshot = {
        bookings: s.bookings,
        slots: slots.filter((x) => key(x.techId, x.date, x.time) !== k),
      };
      const droppedCheck = slotOccupancyCheck(dropped);
      assert.equal(droppedCheck.violations.length, 1, `dropping ${b.ref}'s slot must be caught`);
      assert.equal(droppedCheck.violations[0]?.kind, "active_booking_slot_missing");
      activeProbes += 1;
    }

    // (c) leave a cancelled booking's slot occupied, with nobody active on it
    const orphanCancelled = attributable.filter(
      (b) =>
        b.status === "cancelled" &&
        !activeKeys.has(key(b.techId as number, b.date as string, b.time as string)),
    );
    if (orphanCancelled.length > 0) {
      const b = pick(rnd, orphanCancelled);
      const k = key(b.techId as number, b.date as string, b.time as string);
      const stuck: DbStateSnapshot = {
        bookings: s.bookings,
        slots: slots.map((x) =>
          key(x.techId, x.date, x.time) === k ? { ...x, status: "booked" } : x,
        ),
      };
      const stuckCheck = slotOccupancyCheck(stuck);
      const kinds = stuckCheck.violations.map((v) => v.kind);
      assert.ok(
        stuckCheck.violations.some(
          (v) => v.kind === "cancelled_booking_slot_still_booked" && v.ref === b.ref,
        ),
        `a cancelled booking whose slot stays booked must be caught (got ${JSON.stringify(kinds)})`,
      );
      cancelledProbes += 1;
    }
  }

  assert.ok(activeProbes >= 20, `expected many active-booking probes, ran ${activeProbes}`);
  assert.ok(cancelledProbes >= 1, `expected at least one cancelled-booking probe, ran ${cancelledProbes}`);
});

test("a cancelled booking is NOT flagged when another active booking re-took its slot", () => {
  const check = slotOccupancyCheck({
    bookings: [
      { ref: "HD-1", status: "cancelled", techId: 1, date: D2, time: "10:00" },
      { ref: "HD-2", status: "active", techId: 1, date: D2, time: "10:00" },
    ],
    slots: [{ techId: 1, date: D2, time: "10:00", status: "booked" }],
  });
  assert.deepEqual(check.violations, []);
  assert.equal(check.checked, 2);
});
