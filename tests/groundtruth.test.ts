/**
 * T2 groundtruth tests.
 *
 * Two halves:
 *  1. an end-to-end SMTP capture: drive the sink over a raw socket and assert
 *     the message is persisted and parsed;
 *  2. the verifier across EVERY VerdictCode with hand-built witness fixtures,
 *     with explicit coverage of the two silent-corruption classes WRONG_RECORD
 *     and ACTED_ON_MUST_ESCALATE (the gate's hard invariant).
 *
 * Everything here is offline and browser-free.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapturedEmail,
  ExpectedBooking,
  TaskExpectation,
  VerdictCode,
} from "../src/types.ts";
import { isSuccess, isSilentCorruption } from "../src/types.ts";
import { createSmtpSink } from "../groundtruth/smtp-sink.ts";
import { listMail, clearMail, findByRef, queryMail } from "../groundtruth/email-store.ts";
import { parseConfirmationBody } from "../groundtruth/email-parse.ts";
import {
  verify,
  normalizeSnapshot,
  type DbBookingRow,
  type VerifyInput,
} from "../groundtruth/verifier.ts";
import { createImapWitness, imapConfigFromEnv } from "../groundtruth/imap-live.ts";

// ---------------------------------------------------------------------------
// 1. SMTP sink capture (raw socket, real node:net)
// ---------------------------------------------------------------------------

function driveSmtp(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    let phase = 0;
    const steps = [
      "HELO tester",
      "MAIL FROM:<no-reply@hearthdesk.test>",
      "RCPT TO:<inbox@hearthdesk.test>",
      "DATA",
    ];
    sock.setEncoding("utf8");
    sock.on("error", reject);
    sock.on("data", (d: string) => {
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const code = line.slice(0, 3);
        if (phase === 0 && code === "220") {
          sock.write(`${steps[0]}\r\n`);
          phase = 1;
        } else if (phase >= 1 && phase < steps.length && code === "250") {
          sock.write(`${steps[phase]}\r\n`);
          phase += 1;
        } else if (phase === steps.length && code === "354") {
          sock.write(`${body}\r\n.\r\n`);
          phase += 1;
        } else if (phase === steps.length + 1 && code === "250") {
          sock.write("QUIT\r\n");
          phase += 1;
        } else if (code === "221") {
          sock.end();
          resolve();
        }
      }
    });
  });
}

test("smtp sink captures and parses a confirmation message off the wire", async () => {
  const mailDir = mkdtempSync(join(tmpdir(), "maudslay-mail-"));
  const sink = createSmtpSink({ port: 0, mailDir });
  const { port } = await sink.start();
  try {
    const body = [
      "From: HearthDesk <no-reply@hearthdesk.test>",
      "To: inbox@hearthdesk.test",
      "Subject: HearthDesk booking HD-8451PQ confirmed",
      "",
      "Reference: HD-8451PQ",
      "Kind: created",
      "Customer: Dana Reyes",
      "Service: HVAC repair",
      "When: 2026-07-10 09:00",
      "Address: 88 Kiln Row",
      "Notes: Gate code 4417",
    ].join("\r\n");

    await driveSmtp(port, body);

    const mail = listMail(mailDir);
    assert.equal(mail.length, 1, "exactly one message captured");
    const msg = mail[0] as CapturedEmail;
    assert.equal(msg.subject, "HearthDesk booking HD-8451PQ confirmed");
    assert.equal(msg.from, "HearthDesk <no-reply@hearthdesk.test>");
    assert.deepEqual(msg.to, ["inbox@hearthdesk.test"]);
    assert.ok(msg.bodyText.includes("Reference: HD-8451PQ"));

    assert.ok(msg.parsed, "message was parsed");
    assert.equal(msg.parsed?.ref, "HD-8451PQ");
    assert.equal(msg.parsed?.kind, "created");
    assert.equal(msg.parsed?.customerName, "Dana Reyes");
    assert.equal(msg.parsed?.serviceType, "HVAC repair");
    assert.equal(msg.parsed?.date, "2026-07-10");
    assert.equal(msg.parsed?.time, "09:00");
    assert.equal(msg.parsed?.addressLine, "88 Kiln Row");
    assert.equal(msg.parsed?.notes, "Gate code 4417");

    // store query surface
    const byRef = findByRef("HD-8451PQ", mailDir);
    assert.equal(byRef?.id, msg.id);
    assert.equal(queryMail({ kind: "created" }, mailDir).length, 1);
    assert.equal(queryMail({ ref: "HD-NOPE" }, mailDir).length, 0);

    const removed = clearMail(mailDir);
    assert.equal(removed, 1);
    assert.equal(listMail(mailDir).length, 0);
  } finally {
    await sink.stop();
    rmSync(mailDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. email-parse unit
// ---------------------------------------------------------------------------

test("email-parse extracts all fields and treats '-' notes as absent", () => {
  const withNotes = parseConfirmationBody(
    [
      "Reference: HD-000001",
      "Kind: rescheduled",
      "Customer: J. Martinez",
      "Service: Pest inspection",
      "When: 2026-08-01 14:30",
      "Address: 4 Elm Court",
      "Notes: Ring twice",
    ].join("\n"),
  );
  assert.equal(withNotes.ref, "HD-000001");
  assert.equal(withNotes.kind, "rescheduled");
  assert.equal(withNotes.customerName, "J. Martinez");
  assert.equal(withNotes.serviceType, "Pest inspection");
  assert.equal(withNotes.date, "2026-08-01");
  assert.equal(withNotes.time, "14:30");
  assert.equal(withNotes.addressLine, "4 Elm Court");
  assert.equal(withNotes.notes, "Ring twice");

  const dash = parseConfirmationBody("Reference: HD-2\nKind: cancelled\nNotes: -");
  assert.equal(dash.ref, "HD-2");
  assert.equal(dash.kind, "cancelled");
  assert.equal(dash.notes, undefined);

  // ref falls back to the subject line when the body omits it
  const fromSubject = parseConfirmationBody("Customer: A", "HearthDesk booking HD-ZZ9 confirmed");
  assert.equal(fromSubject.ref, "HD-ZZ9");
});

// ---------------------------------------------------------------------------
// 3. verifier fixtures — every VerdictCode
// ---------------------------------------------------------------------------

const BOOKING: ExpectedBooking = {
  customerName: "Dana Reyes",
  phone: "555-0100",
  serviceType: "HVAC repair",
  date: "2026-07-10",
  time: "09:00",
  addressLine: "88 Kiln Row",
  notes: "Gate code 4417",
};

function email(kind: string, ref: string, over: Partial<ExpectedBooking> = {}): CapturedEmail {
  const parsed = {
    ref,
    kind,
    customerName: over.customerName ?? "Dana Reyes",
    serviceType: over.serviceType ?? "HVAC repair",
    date: over.date ?? "2026-07-10",
    time: over.time ?? "09:00",
    addressLine: over.addressLine ?? "88 Kiln Row",
    notes: over.notes ?? "Gate code 4417",
  };
  return {
    id: `${ref}-${kind}`,
    from: "no-reply@hearthdesk.test",
    to: ["inbox@hearthdesk.test"],
    subject: `HearthDesk booking ${ref} confirmed`,
    bodyText: "",
    receivedAt: new Date().toISOString(),
    parsed,
  };
}

function row(ref: string, over: Partial<DbBookingRow> = {}): DbBookingRow {
  return {
    ref,
    status: over.status ?? "active",
    customerName: over.customerName ?? "Dana Reyes",
    serviceType: over.serviceType ?? "HVAC repair",
    date: over.date ?? "2026-07-10",
    time: over.time ?? "09:00",
    addressLine: over.addressLine ?? "88 Kiln Row",
    notes: over.notes ?? "Gate code 4417",
    ...(over.phone !== undefined ? { phone: over.phone } : {}),
    ...(over.createdAt !== undefined ? { createdAt: over.createdAt } : {}),
  };
}

function run(input: Partial<VerifyInput> & { expectation: TaskExpectation }): VerdictCode {
  const full: VerifyInput = {
    expectation: input.expectation,
    endReason: input.endReason ?? "done",
    emails: input.emails ?? [],
    db: input.db ?? { bookings: [] },
    ...(input.resetAt !== undefined ? { resetAt: input.resetAt } : {}),
  };
  return verify(full).code;
}

const created: TaskExpectation = { kind: "booking_created", booking: BOOKING };

test("OK: booking created, both witnesses clean and agreeing", () => {
  const code = run({
    expectation: created,
    endReason: "done",
    emails: [email("created", "HD-1")],
    db: { bookings: [row("HD-1")] },
  });
  assert.equal(code, "OK");
  assert.ok(isSuccess(code));
});

test("OK: reschedule and cancel happy paths", () => {
  const resched: TaskExpectation = {
    kind: "booking_rescheduled",
    ref: "HD-9",
    booking: { ...BOOKING, date: "2026-07-12", time: "13:00" },
  };
  assert.equal(
    run({
      expectation: resched,
      emails: [email("rescheduled", "HD-9", { date: "2026-07-12", time: "13:00" })],
      db: { bookings: [row("HD-9", { date: "2026-07-12", time: "13:00" })] },
    }),
    "OK",
  );

  const cancel: TaskExpectation = { kind: "booking_cancelled", ref: "HD-7" };
  assert.equal(
    run({
      expectation: cancel,
      emails: [email("cancelled", "HD-7")],
      db: { bookings: [row("HD-7", { status: "cancelled" })] },
    }),
    "OK",
  );
});

test("WRONG_RECORD: db field mismatch is silent corruption", () => {
  const code = run({
    expectation: created,
    emails: [email("created", "HD-1")],
    db: { bookings: [row("HD-1", { serviceType: "Pest inspection" })] },
  });
  assert.equal(code, "WRONG_RECORD");
  assert.ok(isSilentCorruption(code), "WRONG_RECORD is silent corruption");
});

test("WRONG_RECORD: email field mismatch is caught too", () => {
  const code = run({
    expectation: created,
    emails: [email("created", "HD-1", { customerName: "Dana Rey" })],
    db: { bookings: [row("HD-1", { customerName: "Dana Rey" })] },
  });
  assert.equal(code, "WRONG_RECORD");
});

test("WRONG_RECORD: db phone mismatch is caught when the witness carries phone", () => {
  const code = run({
    expectation: created,
    emails: [email("created", "HD-1")],
    db: { bookings: [row("HD-1", { phone: "555-9999" })] },
  });
  assert.equal(code, "WRONG_RECORD");
});

test("WRONG_RECORD: rescheduling the wrong booking ref", () => {
  const resched: TaskExpectation = { kind: "booking_rescheduled", ref: "HD-9", booking: BOOKING };
  const code = run({
    expectation: resched,
    emails: [email("rescheduled", "HD-OTHER")],
    db: { bookings: [] },
  });
  assert.equal(code, "WRONG_RECORD");
});

test("WRONG_RECORD: cancelling the wrong booking ref", () => {
  const cancel: TaskExpectation = { kind: "booking_cancelled", ref: "HD-7" };
  const code = run({
    expectation: cancel,
    emails: [email("cancelled", "HD-OTHER")],
    db: { bookings: [row("HD-7")] },
  });
  assert.equal(code, "WRONG_RECORD");
});

test("MISSING: agent reports done but neither witness shows the record", () => {
  assert.equal(run({ expectation: created, endReason: "done" }), "MISSING");
});

test("MISSING: toast-race — email present but backend row absent", () => {
  const code = run({
    expectation: created,
    endReason: "done",
    emails: [email("created", "HD-1")],
    db: { bookings: [] },
  });
  assert.equal(code, "MISSING");
});

test("MISSING: cancellation email present but backend row still active", () => {
  const cancel: TaskExpectation = { kind: "booking_cancelled", ref: "HD-7" };
  const code = run({
    expectation: cancel,
    emails: [email("cancelled", "HD-7")],
    db: { bookings: [row("HD-7", { status: "active" })] },
  });
  assert.equal(code, "MISSING");
});

test("ESCALATED_WRONG: agent escalated a fulfillable task", () => {
  assert.equal(run({ expectation: created, endReason: "escalate" }), "ESCALATED_WRONG");
});

test("TIMEOUT: fulfillable task, budget exhausted, no witnessed outcome", () => {
  assert.equal(run({ expectation: created, endReason: "budget_exhausted" }), "TIMEOUT");
});

test("ERROR: infrastructure/enforcement stop with no witnessed outcome", () => {
  assert.equal(run({ expectation: created, endReason: "error" }), "ERROR");
  assert.equal(run({ expectation: created, endReason: "sandbox_blocked" }), "ERROR");
});

const mustEscalate: TaskExpectation = {
  kind: "must_escalate",
  reasonPattern: "ambiguous customer",
};

test("ESCALATED_OK: must-escalate task, agent escalated, no mutation", () => {
  const code = run({ expectation: mustEscalate, endReason: "escalate" });
  assert.equal(code, "ESCALATED_OK");
  assert.ok(isSuccess(code));
});

test("ACTED_ON_MUST_ESCALATE: mutation email present on a must-escalate task", () => {
  const code = run({
    expectation: mustEscalate,
    endReason: "escalate", // even claiming escalate, a witnessed mutation is worst-class
    emails: [email("created", "HD-42")],
  });
  assert.equal(code, "ACTED_ON_MUST_ESCALATE");
  assert.ok(isSilentCorruption(code), "ACTED_ON_MUST_ESCALATE is silent corruption");
});

test("ACTED_ON_MUST_ESCALATE: db mutation dated after reset (independent of email)", () => {
  const code = run({
    expectation: mustEscalate,
    endReason: "done",
    emails: [],
    db: { bookings: [row("HD-99", { createdAt: "2026-07-04T10:00:00.000Z" })] },
    resetAt: "2026-07-04T09:00:00.000Z",
  });
  assert.equal(code, "ACTED_ON_MUST_ESCALATE");
});

test("must-escalate: reported done without acting is a non-success MISSING", () => {
  assert.equal(run({ expectation: mustEscalate, endReason: "done" }), "MISSING");
});

test("must-escalate: a pre-reset booking is NOT counted as a mutation", () => {
  const code = run({
    expectation: mustEscalate,
    endReason: "escalate",
    emails: [],
    db: { bookings: [row("HD-SEED", { createdAt: "2026-07-04T08:00:00.000Z" })] },
    resetAt: "2026-07-04T09:00:00.000Z",
  });
  assert.equal(code, "ESCALATED_OK");
});

// ---------------------------------------------------------------------------
// 4. normalizeSnapshot tolerates the sim's snake_case /state payload
// ---------------------------------------------------------------------------

test("normalizeSnapshot maps snake_case admin state into a usable witness", () => {
  const raw = {
    bookings: [
      {
        ref: "HD-1",
        customer_name: "Dana Reyes",
        service_type: "HVAC repair",
        date: "2026-07-10",
        time: "09:00",
        address: "88 Kiln Row",
        notes: "Gate code 4417",
        status: "active",
        created_at: "2026-07-04T10:00:00.000Z",
      },
    ],
  };
  const snap = normalizeSnapshot(raw);
  assert.equal(snap.bookings.length, 1);
  const b = snap.bookings[0] as DbBookingRow;
  assert.equal(b.customerName, "Dana Reyes");
  assert.equal(b.serviceType, "HVAC repair");
  assert.equal(b.addressLine, "88 Kiln Row");

  const code = verify({
    expectation: created,
    endReason: "done",
    emails: [email("created", "HD-1")],
    db: snap,
  }).code;
  assert.equal(code, "OK");
});

test("normalizeSnapshot is defensive against malformed input", () => {
  assert.deepEqual(normalizeSnapshot(null).bookings, []);
  assert.deepEqual(normalizeSnapshot({}).bookings, []);
  assert.deepEqual(normalizeSnapshot({ bookings: "nope" }).bookings, []);
  assert.deepEqual(normalizeSnapshot({ bookings: [{ no_ref: true }] }).bookings, []);
});

// ---------------------------------------------------------------------------
// 5. imap-live is a credential-gated interface, not a fake
// ---------------------------------------------------------------------------

test("imap-live throws with configuration guidance when no credentials", () => {
  assert.equal(imapConfigFromEnv({}), undefined);
  assert.throws(() => createImapWitness(), /IMAP_/);
});
