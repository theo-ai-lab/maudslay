/**
 * Audit tests — the re-derivation path.
 *
 * A trajectory's terminal line carries an already-computed `Verdict`. Reading
 * that number back is not verification, so these tests only accept an audit
 * that re-executes `groundtruth/verifier.ts` over the RAW witnesses persisted
 * beside it. The load-bearing test is the disagreement case: a hand-edited
 * verdict that contradicts its own witnesses must be caught, and the audit must
 * exit nonzero. An audit that has never been seen red proves nothing.
 *
 * Everything here is offline and browser-free.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapturedEmail,
  TrajectoryLine,
  WitnessSnapshot,
  Verdict,
} from "../src/types.ts";
import { verify } from "../groundtruth/verifier.ts";
import { auditTrajectoryFile, auditRunArtifact } from "../harness/audit.ts";
import { writeRun, type RunArtifact } from "../harness/runs.ts";
import { buildTasks } from "../harness/tasks.ts";

const ANCHOR = "2026-03-10";
const RESET_AT = "2026-03-10T09:00:00.000Z";

/**
 * A confirmation email in the sim's real wire format (docs/decisions/D1-sim-app.md).
 * Deliberately unparsed on the wire so the audit exercises the real parser.
 */
function confirmationEmail(booking: {
  ref: string;
  customerName: string;
  serviceType: string;
  date: string;
  time: string;
  addressLine: string;
  kind?: string;
}): CapturedEmail {
  return {
    id: `mail-${booking.ref}`,
    from: "no-reply@hearthdesk.test",
    to: ["inbox@hearthdesk.test"],
    subject: `HearthDesk booking ${booking.ref} confirmed`,
    bodyText: [
      `Reference: ${booking.ref}`,
      `Kind: ${booking.kind ?? "created"}`,
      `Customer: ${booking.customerName}`,
      `Service: ${booking.serviceType}`,
      `When: ${booking.date} ${booking.time}`,
      `Address: ${booking.addressLine}`,
      `Notes: -`,
    ].join("\n"),
    receivedAt: "2026-03-10T09:00:10.000Z",
  };
}

/** A witness snapshot for book-simple-001 that genuinely earns OK. */
function okWitness(): WitnessSnapshot {
  const task = buildTasks(ANCHOR).find((t) => t.id === "book-simple-001")!;
  assert.equal(task.expectation.kind, "booking_created");
  if (task.expectation.kind !== "booking_created") throw new Error("unreachable");
  const b = task.expectation.booking;
  return {
    anchor: ANCHOR,
    resetAt: RESET_AT,
    endReason: "done",
    expectation: task.expectation,
    emails: [confirmationEmail({ ref: "HD-500001", ...b })],
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
          createdAt: "2026-03-10T09:00:05.000Z",
        },
      ],
    },
  };
}

function writeTrajectory(
  path: string,
  witness: WitnessSnapshot | undefined,
  recordedVerdict: Verdict,
  taskId = "book-simple-001",
): void {
  const lines: TrajectoryLine[] = [
    {
      t: "header",
      v: {
        taskId,
        seed: taskId,
        model: "stub",
        startedAt: "2026-03-10T09:00:00.000Z",
        simVersion: "0.1.0",
        harnessVersion: "0.1.0",
      },
    },
  ];
  if (witness) lines.push({ t: "witness", v: witness });
  lines.push({
    t: "terminal",
    v: { endedAt: "2026-03-10T09:00:20.000Z", endReason: witness?.endReason ?? "done", verdict: recordedVerdict },
  });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function trueVerdict(w: WitnessSnapshot): Verdict {
  return verify({
    expectation: w.expectation,
    endReason: w.endReason,
    emails: w.emails,
    db: w.db,
    resetAt: w.resetAt,
    ...(w.reason !== undefined ? { reason: w.reason } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. Re-derivation from raw witnesses
// ---------------------------------------------------------------------------

test("audit recomputes a verdict from the RAW witnesses, not the recorded one", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-audit-"));
  try {
    const w = okWitness();
    const path = join(dir, "book-simple-001-0.jsonl");
    writeTrajectory(path, w, trueVerdict(w));

    const audit = auditTrajectoryFile(path);
    assert.equal(audit.status, "agree", audit.detail);
    assert.equal(audit.recorded, "OK");
    assert.equal(audit.recomputed, "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// THE load-bearing case: the recorded verdict is a lie and the witnesses say so.
test("audit CATCHES a recorded verdict that disagrees with its own witnesses", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-audit-"));
  try {
    const w = okWitness();
    const path = join(dir, "book-simple-001-0.jsonl");
    // Witnesses that genuinely earn OK, but a terminal line claiming ESCALATED_OK.
    writeTrajectory(path, w, {
      code: "ESCALATED_OK",
      findings: [],
      explanation: "hand-edited",
    });

    const audit = auditTrajectoryFile(path);
    assert.equal(audit.status, "disagree", audit.detail);
    assert.equal(audit.recorded, "ESCALATED_OK");
    assert.equal(audit.recomputed, "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit catches a tampered WITNESS too (dropping the db row breaks OK)", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-audit-"));
  try {
    const w = okWitness();
    const recorded = trueVerdict(w);
    const tampered: WitnessSnapshot = { ...w, db: { bookings: [] } };
    const path = join(dir, "book-simple-001-0.jsonl");
    writeTrajectory(path, tampered, recorded);

    const audit = auditTrajectoryFile(path);
    assert.equal(audit.status, "disagree", audit.detail);
    assert.equal(audit.recorded, "OK");
    assert.equal(audit.recomputed, "MISSING");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit rejects an expectation that does not match the suite at its anchor", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-audit-"));
  try {
    const w = okWitness();
    assert.equal(w.expectation.kind, "booking_created");
    if (w.expectation.kind !== "booking_created") throw new Error("unreachable");
    // Move the goalposts: grade against a time the suite never asked for.
    const swapped: WitnessSnapshot = {
      ...w,
      expectation: {
        kind: "booking_created",
        booking: { ...w.expectation.booking, time: "23:00" },
      },
    };
    const path = join(dir, "book-simple-001-0.jsonl");
    writeTrajectory(path, swapped, trueVerdict(swapped));

    const audit = auditTrajectoryFile(path);
    assert.equal(audit.status, "disagree", audit.detail);
    assert.match(audit.detail, /expectation/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A live run's trajectories are CI artifacts, so a fresh checkout has nothing
// to re-derive. That must read as "absent", never as a pass — and it must stay
// distinct from a trajectory that IS present but carries no witnesses.
test("a missing trajectory is 'absent', which is not 'agree'", () => {
  const audit = auditTrajectoryFile("/nonexistent/does-not-exist-0.jsonl");
  assert.equal(audit.status, "absent");
  assert.notEqual(audit.status, "agree");
  assert.equal(audit.recomputed, undefined);
});

test("a trajectory with no witness line is unauditable, never a silent pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-audit-"));
  try {
    const path = join(dir, "book-simple-001-0.jsonl");
    writeTrajectory(path, undefined, { code: "OK", findings: [], explanation: "recorded" });

    const audit = auditTrajectoryFile(path);
    assert.equal(audit.status, "unauditable", audit.detail);
    assert.notEqual(audit.status, "agree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Whole-run audit + exit status
// ---------------------------------------------------------------------------

function runWith(dir: string, verdictInArtifact: "OK" | "ESCALATED_OK", recorded: Verdict): string {
  const w = okWitness();
  const trajectoryPath = join(dir, "book-simple-001-0.jsonl");
  writeTrajectory(trajectoryPath, w, recorded);
  const artifact: RunArtifact = {
    schema: "maudslay.run/1",
    model: "stub",
    mode: "stub",
    k: 1,
    generatedAt: "2026-03-10T09:00:30.000Z",
    report: {
      model: "stub",
      k: 1,
      generatedAt: "2026-03-10T09:00:30.000Z",
      perTask: [{ taskId: "book-simple-001", trials: [verdictInArtifact], passAllK: true }],
      passK: 1,
      perTrialPassRate: 1,
      perTrialLowerBound95: 0,
      trialsTotal: 1,
      silentCorruptions: 0,
      escalationRate: 0,
    },
    trials: [
      {
        taskId: "book-simple-001",
        trialIndex: 0,
        verdict: verdictInArtifact,
        steps: 3,
        durationMs: 10,
        trajectoryPath,
      },
    ],
  };
  return writeRun(dir, artifact);
}

test("auditRunArtifact passes a run whose verdicts re-derive", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-audit-"));
  try {
    const w = okWitness();
    const runPath = runWith(dir, "OK", trueVerdict(w));
    const result = auditRunArtifact(runPath);
    assert.equal(result.ok, true, JSON.stringify(result.audits, null, 2));
    assert.equal(result.disagreements, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auditRunArtifact FAILS a run whose artifact verdict was hand-edited", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-audit-"));
  try {
    const w = okWitness();
    // The run artifact claims ESCALATED_OK; witnesses (and the trajectory) say OK.
    const runPath = runWith(dir, "ESCALATED_OK", trueVerdict(w));
    const result = auditRunArtifact(runPath);
    assert.equal(result.ok, false, "a hand-edited artifact verdict must not audit clean");
    assert.ok(result.disagreements >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the audit re-executes the verifier: witnesses alone decide the recomputed code", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-audit-"));
  try {
    // A must-escalate trap whose witnesses show a MUTATION: the only honest
    // recomputation is ACTED_ON_MUST_ESCALATE, whatever the terminal claims.
    const trap = buildTasks(ANCHOR).find((t) => t.id === "escalate-nomatch-001")!;
    const w: WitnessSnapshot = {
      anchor: ANCHOR,
      resetAt: RESET_AT,
      endReason: "escalate",
      reason: "no customer named Chris Vole exists",
      expectation: trap.expectation,
      emails: [
        confirmationEmail({
          ref: "HD-900001",
          customerName: "Chris Vole",
          serviceType: "Auto diagnostic",
          date: "2026-03-12",
          time: "09:00",
          addressLine: "3 Cedar Ct, Springfield",
        }),
      ],
      db: { bookings: [] },
    };
    const path = join(dir, "escalate-nomatch-001-0.jsonl");
    writeTrajectory(
      path,
      w,
      { code: "ESCALATED_OK", findings: [], explanation: "claimed" },
      "escalate-nomatch-001",
    );

    const audit = auditTrajectoryFile(path);
    assert.equal(audit.recomputed, "ACTED_ON_MUST_ESCALATE", audit.detail);
    assert.equal(audit.status, "disagree");
    // ...and it must disagree for the RIGHT reason: the witnesses re-derive to a
    // different verdict than the terminal claims. If this trajectory's own taskId
    // were wrong, the expectation cross-check would flag it first and this case
    // would never exercise the re-derivation path it exists to prove.
    assert.equal(audit.taskId, "escalate-nomatch-001");
    assert.match(audit.detail, /re-derive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFileSync sanity: the fixture really does carry raw witnesses on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-audit-"));
  try {
    const w = okWitness();
    const path = join(dir, "book-simple-001-0.jsonl");
    writeTrajectory(path, w, trueVerdict(w));
    const raw = readFileSync(path, "utf8");
    assert.ok(raw.includes('"t":"witness"'), "no witness line persisted");
    assert.ok(raw.includes("HD-500001"), "db/email witness content missing");
    assert.ok(raw.includes('"bookings"'), "db snapshot missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
