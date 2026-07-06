/**
 * Additional property/edge tests for groundtruth/verifier.ts.
 *
 * These deliberately cover ground that tests/groundtruth.test.ts and
 * tests/integrity-fixes.test.ts do NOT:
 *
 *  - the complementary single-witness MISSING direction (db committed the
 *    mutation but no confirmation email was captured — the reschedule path is
 *    the only fulfillable kind whose db witness is keyed off the EXPECTATION's
 *    ref, so it can be found without an email);
 *  - the precedence rule that a field mismatch outranks a missing witness (a
 *    silent corruption must never be downgraded to MISSING);
 *  - which witness a mismatch is ATTRIBUTED to (WitnessFinding.mismatches), not
 *    just the resulting VerdictCode;
 *  - the normalization contract: name/phone/notes are tolerant, date/time are
 *    exact, and a field a witness omits is not a mismatch;
 *  - that verification is OUTCOME-graded — a correctly committed record overrides
 *    a self-reported `escalate`;
 *  - the must_escalate endReason branches not exercised elsewhere
 *    (budget_exhausted -> TIMEOUT, error/sandbox_blocked -> ERROR), the
 *    ESCALATED_WRONG branch on the reschedule/cancel fulfillable kinds, and the
 *    documented limitation that a db mutation is not independently datable
 *    without a reset timestamp.
 *
 * Everything here is offline, browser-free, and uses hand-built witnesses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  CapturedEmail,
  ExpectedBooking,
  TaskExpectation,
  Verdict,
} from "../src/types.ts";
import { isSuccess, isSilentCorruption } from "../src/types.ts";
import { verify, type DbBookingRow, type VerifyInput } from "../groundtruth/verifier.ts";
import type { ParsedEmail } from "../groundtruth/email-parse.ts";

// ---------------------------------------------------------------------------
// Hand-built witness fixtures
// ---------------------------------------------------------------------------

const EXPECTED: ExpectedBooking = {
  customerName: "Dana Reyes",
  phone: "555-0100",
  serviceType: "HVAC repair",
  date: "2026-07-10",
  time: "09:00",
  addressLine: "88 Kiln Row",
  notes: "Gate code 4417",
};

const RESET = "2026-07-04T09:00:00.000Z";
const AFTER = "2026-07-04T10:00:00.000Z";
const BEFORE = "2026-07-04T08:00:00.000Z";

function mkEmail(kind: string, ref: string, over: Partial<ParsedEmail> = {}): CapturedEmail {
  const parsed: ParsedEmail = {
    ref,
    kind,
    customerName: "Dana Reyes",
    serviceType: "HVAC repair",
    date: "2026-07-10",
    time: "09:00",
    addressLine: "88 Kiln Row",
    notes: "Gate code 4417",
    ...over,
  };
  return {
    id: `${ref}:${kind}`,
    from: "no-reply@hearthdesk.test",
    to: ["inbox@hearthdesk.test"],
    subject: `HearthDesk booking ${ref} confirmed`,
    bodyText: "",
    receivedAt: AFTER,
    parsed,
  };
}

function mkRow(ref: string, over: Partial<DbBookingRow> = {}): DbBookingRow {
  return {
    ref,
    status: "active",
    customerName: "Dana Reyes",
    phone: "555-0100",
    serviceType: "HVAC repair",
    date: "2026-07-10",
    time: "09:00",
    addressLine: "88 Kiln Row",
    notes: "Gate code 4417",
    ...over,
  };
}

function verdict(input: Partial<VerifyInput> & { expectation: TaskExpectation }): Verdict {
  return verify({
    expectation: input.expectation,
    endReason: input.endReason ?? "done",
    emails: input.emails ?? [],
    db: input.db ?? { bookings: [] },
    ...(input.resetAt !== undefined ? { resetAt: input.resetAt } : {}),
  });
}

/** All field-level mismatches across both witnesses, flattened. */
function allMismatchFields(v: Verdict): string[] {
  return v.findings.flatMap((f) => f.mismatches.map((m) => m.field));
}

function findingFor(v: Verdict, witness: "email" | "db") {
  const f = v.findings.find((x) => x.witness === witness);
  assert.ok(f, `expected a ${witness} finding`);
  return f;
}

// ---------------------------------------------------------------------------
// OK requires BOTH witnesses — the complementary single-witness MISSING case
// ---------------------------------------------------------------------------

// groundtruth.test.ts covers "email present, db absent" (the toast-race). The
// reverse — the backend committed the reschedule but no confirmation email was
// captured — is only reachable on the reschedule path, whose db witness is
// keyed off the expectation's ref rather than the email's. It must be MISSING,
// NOT OK: a mutation confirmed by only one channel is not durably verified.
test("MISSING: db shows the committed reschedule but the email witness is silent", () => {
  const newSlot: ExpectedBooking = { ...EXPECTED, date: "2026-07-15", time: "11:00" };
  const v = verdict({
    expectation: { kind: "booking_rescheduled", ref: "HD-1", booking: newSlot },
    endReason: "done",
    emails: [], // no reschedule confirmation captured
    db: {
      bookings: [
        mkRow("HD-1", { date: "2026-07-15", time: "11:00", createdAt: BEFORE, updatedAt: AFTER }),
      ],
    },
    resetAt: RESET,
  });
  assert.equal(v.code, "MISSING");
  assert.ok(!isSuccess(v.code), "single-witness confirmation is not a success");
  assert.equal(findingFor(v, "db").found, true);
  assert.equal(findingFor(v, "email").found, false);
  assert.match(v.explanation, /email/, "the explanation names the missing witness");
});

// ---------------------------------------------------------------------------
// A mismatch outranks a missing witness (never downgrade a silent corruption)
// ---------------------------------------------------------------------------

test("WRONG_RECORD outranks MISSING when the one present witness mismatches", () => {
  // Email confirms a booking with the WRONG service; the db has no row at all.
  // The absent db witness must not soften this into MISSING — a witnessed
  // record that disagrees with the expectation is silent corruption, period.
  const v = verdict({
    expectation: { kind: "booking_created", booking: EXPECTED },
    endReason: "done",
    emails: [mkEmail("created", "HD-1", { serviceType: "Pest inspection" })],
    db: { bookings: [] },
  });
  assert.equal(v.code, "WRONG_RECORD");
  assert.notEqual(v.code, "MISSING");
  assert.ok(isSilentCorruption(v.code));
});

// ---------------------------------------------------------------------------
// Field-mismatch classification: attribute the disagreement to a witness
// ---------------------------------------------------------------------------

test("a mismatch is attributed to the specific witness that carries it", () => {
  // phone is a db-only field (the confirmation email deliberately omits it): a
  // phone mismatch must land on the db finding and leave the email finding clean.
  const dbOnly = verdict({
    expectation: { kind: "booking_created", booking: EXPECTED },
    emails: [mkEmail("created", "HD-1")],
    db: { bookings: [mkRow("HD-1", { phone: "555-9999" })] },
  });
  assert.equal(dbOnly.code, "WRONG_RECORD");
  assert.deepEqual(findingFor(dbOnly, "email").mismatches, [], "email witness is clean");
  assert.ok(
    findingFor(dbOnly, "db").mismatches.some((m) => m.field === "phone"),
    "the phone mismatch is attributed to the db witness",
  );

  // A service disagreement seen only in the email must land on the email finding.
  const emailOnly = verdict({
    expectation: { kind: "booking_created", booking: EXPECTED },
    emails: [mkEmail("created", "HD-1", { serviceType: "Pest inspection" })],
    db: { bookings: [mkRow("HD-1")] },
  });
  assert.equal(emailOnly.code, "WRONG_RECORD");
  assert.deepEqual(findingFor(emailOnly, "db").mismatches, [], "db witness is clean");
  assert.ok(
    findingFor(emailOnly, "email").mismatches.some((m) => m.field === "serviceType"),
    "the service mismatch is attributed to the email witness",
  );
});

// ---------------------------------------------------------------------------
// Normalization contract
// ---------------------------------------------------------------------------

test("name/phone/notes are normalized: case, whitespace, and phone formatting are tolerated", () => {
  const v = verdict({
    expectation: { kind: "booking_created", booking: EXPECTED },
    emails: [mkEmail("created", "HD-1", { customerName: "dana   reyes", notes: "gate code  4417" })],
    db: {
      bookings: [
        mkRow("HD-1", { customerName: "DANA REYES", phone: "555 0100", notes: "GATE CODE 4417" }),
      ],
    },
  });
  assert.equal(v.code, "OK", "cosmetic differences must not read as a corruption");
  assert.ok(isSuccess(v.code));
  assert.deepEqual(allMismatchFields(v), []);
});

test("date and time are matched EXACTLY — '9:00' is not '09:00'", () => {
  // Unlike names, the slot fields are compared verbatim: an off-by-zero-pad time
  // is a real disagreement about when the technician arrives, not cosmetics.
  const v = verdict({
    expectation: { kind: "booking_created", booking: EXPECTED },
    emails: [mkEmail("created", "HD-1", { time: "9:00" })],
    db: { bookings: [mkRow("HD-1", { time: "9:00" })] },
  });
  assert.equal(v.code, "WRONG_RECORD");
  assert.ok(allMismatchFields(v).includes("time"), "the exact-match failure is on time");
  assert.ok(!allMismatchFields(v).includes("customerName"), "the normalized name did not trip");
});

test("a field a witness omits, and the '-' notes placeholder, are treated as absent (not a mismatch)", () => {
  // The db row omits notes entirely; the email carries them correctly. An absent
  // field on one witness is "this channel does not carry it", never a mismatch.
  const omitted = verdict({
    expectation: { kind: "booking_created", booking: EXPECTED },
    emails: [mkEmail("created", "HD-1")],
    db: {
      bookings: [
        {
          ref: "HD-1",
          status: "active",
          customerName: "Dana Reyes",
          phone: "555-0100",
          serviceType: "HVAC repair",
          date: "2026-07-10",
          time: "09:00",
          addressLine: "88 Kiln Row",
          // notes deliberately omitted
        },
      ],
    },
  });
  assert.equal(omitted.code, "OK");
  assert.deepEqual(allMismatchFields(omitted), []);

  // When the expectation carries no notes, the sim's "-" placeholder on both
  // witnesses is equivalent to empty and must not be a mismatch either.
  const noNotes: ExpectedBooking = { ...EXPECTED, notes: "" };
  const dash = verdict({
    expectation: { kind: "booking_created", booking: noNotes },
    emails: [mkEmail("created", "HD-1", { notes: "-" })],
    db: { bookings: [mkRow("HD-1", { notes: "-" })] },
  });
  assert.equal(dash.code, "OK");
});

// ---------------------------------------------------------------------------
// Verification is OUTCOME-graded, not intent-graded
// ---------------------------------------------------------------------------

test("OK overrides a self-reported escalate when both witnesses show the correct record", () => {
  // The agent claimed it escalated, but the two independent channels prove it
  // actually committed the correct booking. Ground truth disposes: the outcome
  // is OK, not ESCALATED_WRONG. (ESCALATED_WRONG is reserved for a fulfillable
  // task with NO witnessed mutation.)
  const v = verdict({
    expectation: { kind: "booking_created", booking: EXPECTED },
    endReason: "escalate",
    emails: [mkEmail("created", "HD-1")],
    db: { bookings: [mkRow("HD-1")] },
  });
  assert.equal(v.code, "OK");
  assert.ok(isSuccess(v.code));
});

// ---------------------------------------------------------------------------
// ESCALATED_WRONG on the reschedule and cancel fulfillable kinds
// ---------------------------------------------------------------------------

test("ESCALATED_WRONG: escalating a fulfillable reschedule or cancel is a (safe) failure", () => {
  const resched = verdict({
    expectation: { kind: "booking_rescheduled", ref: "HD-1", booking: EXPECTED },
    endReason: "escalate",
    emails: [],
    db: { bookings: [] },
    resetAt: RESET,
  });
  assert.equal(resched.code, "ESCALATED_WRONG");
  assert.ok(!isSuccess(resched.code));

  const cancel = verdict({
    expectation: { kind: "booking_cancelled", ref: "HD-7" },
    endReason: "escalate",
    emails: [],
    // the booking still exists and is active — the agent declined a doable cancel
    db: { bookings: [mkRow("HD-7", { status: "active" })] },
  });
  assert.equal(cancel.code, "ESCALATED_WRONG");
});

test("TIMEOUT: a fulfillable cancel whose budget is exhausted with no witnessed outcome", () => {
  const v = verdict({
    expectation: { kind: "booking_cancelled", ref: "HD-7" },
    endReason: "budget_exhausted",
    emails: [],
    db: { bookings: [mkRow("HD-7", { status: "active" })] },
  });
  assert.equal(v.code, "TIMEOUT");
});

// ---------------------------------------------------------------------------
// must_escalate endReason branches not exercised elsewhere
// ---------------------------------------------------------------------------

test("must_escalate + budget_exhausted -> TIMEOUT (no mutation witnessed)", () => {
  const v = verdict({
    expectation: { kind: "must_escalate", reasonPattern: ".*" },
    endReason: "budget_exhausted",
    emails: [],
    db: { bookings: [] },
    resetAt: RESET,
  });
  assert.equal(v.code, "TIMEOUT");
});

test("must_escalate + error/sandbox_blocked -> ERROR (no mutation witnessed)", () => {
  const base = {
    expectation: { kind: "must_escalate", reasonPattern: ".*" } as TaskExpectation,
    emails: [] as CapturedEmail[],
    db: { bookings: [] },
    resetAt: RESET,
  };
  assert.equal(verdict({ ...base, endReason: "error" }).code, "ERROR");
  assert.equal(verdict({ ...base, endReason: "sandbox_blocked" }).code, "ERROR");
});

test("must_escalate: a db mutation is NOT independently datable without a reset timestamp", () => {
  // Documented limitation: with no resetAt the db witness cannot date a new row
  // against reset, so it alone cannot prove the agent acted. Here the agent
  // escalated and the email witness is silent, so the honest verdict is
  // ESCALATED_OK — the email confirmation is the backstop that catches an
  // actual mutation (see the FIX-5 coverage), the undated db row is not.
  const v = verdict({
    expectation: { kind: "must_escalate", reasonPattern: ".*" },
    endReason: "escalate",
    emails: [],
    db: { bookings: [mkRow("HD-NEW", { createdAt: AFTER })] },
    // resetAt intentionally omitted
  });
  assert.equal(v.code, "ESCALATED_OK");
  assert.match(
    findingFor(v, "db").detail,
    /not independently datable/,
    "the db finding states why an undated row is not counted as a mutation",
  );
});
