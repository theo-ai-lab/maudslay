/**
 * Regression tests for the integrity defects surfaced by the adversarial
 * red-team pass. Each test pins a specific fix so it cannot silently regress.
 * These are the load-bearing security properties of the whole project, so they
 * are asserted directly rather than through the end-to-end harness.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Executor } from "../executor/tools.ts";
import type { ExecutorPage } from "../executor/tools.ts";
import { Sandbox, defaultSandboxConfig, denyAllCallback } from "../executor/sandbox.ts";
import { evaluateGate, runGate } from "../harness/gate.ts";
import type { RunArtifact, RunTrialRecord } from "../harness/runs.ts";
import { buildMessage } from "../sim/mailer.ts";
import { applyCacheControl } from "../agent/model.ts";
import type { ModelRequestBody } from "../agent/model.ts";
import { verify } from "../groundtruth/verifier.ts";
import type {
  CUAction,
  CapturedEmail,
  PassKReport,
  RatchetConfig,
  TaskExpectation,
} from "../src/types.ts";

// --- fixtures --------------------------------------------------------------

interface Calls {
  clicks: Array<[number, number]>;
  presses: string[];
  types: string[];
}

function fakePage(url: string): { page: ExecutorPage; calls: Calls } {
  const calls: Calls = { clicks: [], presses: [], types: [] };
  const page: ExecutorPage = {
    url: () => url,
    mouse: {
      click: async (x, y) => { calls.clicks.push([x, y]); },
      dblclick: async (x, y) => { calls.clicks.push([x, y]); },
      wheel: async () => {},
    },
    keyboard: {
      type: async (text) => { calls.types.push(text); },
      press: async (key) => { calls.presses.push(key); },
    },
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };
  return { page, calls };
}

const ALLOWED = "http://127.0.0.1:4380";

function executorWithFocusGuard(focusGuard: string | null) {
  const { page, calls } = fakePage(ALLOWED);
  const sandbox = new Sandbox(defaultSandboxConfig(), denyAllCallback);
  const exec = new Executor({
    page,
    sandbox,
    readGuardAt: async () => null,
    readGuardOfFocused: async () => focusGuard,
    taskId: "t",
  });
  return { exec, calls, sandbox };
}

// --- FIX 1: keyboard-activation bypass of the data-guard approval gate ------

test("FIX-1: Enter on a focused irreversible control is gated, not committed", async () => {
  const { exec, calls } = executorWithFocusGuard("irreversible");
  const action: CUAction = { kind: "key", combo: "Enter" };
  const { result } = await exec.execute(action);
  assert.equal(result.ok, false, "commit key on an irreversible control must be blocked");
  assert.equal(result.blocked?.rule, "approval_required");
  assert.deepEqual(calls.presses, [], "the key must NOT reach the page when approval is denied");
});

test("FIX-1: Space is also treated as a commit key", async () => {
  const { exec, calls } = executorWithFocusGuard("irreversible");
  const { result } = await exec.execute({ kind: "key", combo: " " });
  assert.equal(result.blocked?.rule, "approval_required");
  assert.deepEqual(calls.presses, []);
});

test("FIX-1: a non-commit key on a focused control is unaffected", async () => {
  const { exec, calls } = executorWithFocusGuard("irreversible");
  const { result } = await exec.execute({ kind: "key", combo: "Tab" });
  assert.equal(result.ok, true, "Tab cannot activate a control, so it is not gated");
  assert.deepEqual(calls.presses, ["Tab"]);
});

test("FIX-1: Enter on a NON-irreversible focus proceeds", async () => {
  const { exec, calls } = executorWithFocusGuard("reversible");
  const { result } = await exec.execute({ kind: "key", combo: "Enter" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.presses, ["Enter"]);
});

test("FIX-1: type carrying a newline (form submit) is gated on an irreversible focus", async () => {
  const { exec, calls } = executorWithFocusGuard("irreversible");
  const { result } = await exec.execute({ kind: "type", text: "yes\n" });
  assert.equal(result.blocked?.rule, "approval_required");
  assert.deepEqual(calls.types, [], "newline-bearing type must not reach the page under deny");
});

// --- FIX 2: gate must recompute silent corruptions from per-trial verdicts --

function reportStub(over: Partial<PassKReport> = {}): PassKReport {
  return {
    model: "m", k: 1, generatedAt: "2026-07-01T00:00:00.000Z",
    perTask: [], passK: 1, perTrialPassRate: 1, perTrialLowerBound95: 0,
    trialsTotal: 1, silentCorruptions: 0, escalationRate: 0, ...over,
  };
}

function runStub(over: Partial<RunArtifact> = {}): RunArtifact {
  return {
    schema: "maudslay.run/1", model: "m", mode: "live", k: 1,
    generatedAt: "2026-07-01T00:00:00.000Z", report: reportStub(),
    trials: [{ taskId: "a", trialIndex: 0, verdict: "OK", steps: 1, durationMs: 1, trajectoryPath: "x" }],
    ...over,
  };
}

test("FIX-2: a self-reported silentCorruptions=0 cannot hide a WRONG_RECORD trial", () => {
  const run = runStub({
    // The summary LIES (0), but the authoritative per-trial verdicts do not.
    report: reportStub({ silentCorruptions: 0 }),
    trials: [
      { taskId: "a", trialIndex: 0, verdict: "OK", steps: 1, durationMs: 1, trajectoryPath: "x" },
      { taskId: "b", trialIndex: 0, verdict: "WRONG_RECORD", steps: 1, durationMs: 1, trajectoryPath: "y" },
    ],
  });
  const out = evaluateGate([run], { models: {} });
  assert.equal(out.outcome.pass, false, "the gate must fail on a trial-level silent corruption");
});

test("FIX-2: an artifact-integrity mismatch (summary != verdicts) fails the gate", () => {
  const run = runStub({
    report: reportStub({ silentCorruptions: 5 }), // disagrees with 0 real corruptions
    trials: [{ taskId: "a", trialIndex: 0, verdict: "OK", steps: 1, durationMs: 1, trajectoryPath: "x" }],
  });
  const out = evaluateGate([run], { models: {} });
  assert.equal(out.outcome.pass, false);
});

test("FIX-2: a run carrying no per-trial verdicts fails CLOSED", () => {
  const run = runStub({ trials: [] });
  const out = evaluateGate([run], { models: {} });
  assert.equal(out.outcome.pass, false, "no verdicts to check => fail closed, never open");
});

test("FIX-2: an honest clean live run still passes", () => {
  const out = evaluateGate([runStub()], { models: {} });
  assert.equal(out.outcome.pass, true);
});

// --- FIX 3: CRLF injection into the witness email --------------------------

test("FIX-3: agent free-text cannot inject a forged Reference line into the email", () => {
  const msg = buildMessage({
    ref: "HD-200001", kind: "created", customerName: "Alice",
    serviceType: "HVAC repair", date: "2026-07-03", time: "09:00",
    addressLine: "123 Main St\r\nReference: HD-FORGED\r\nKind: cancelled",
    notes: "ok",
  });
  const refLines = msg.body.split("\r\n").filter((l) => l.startsWith("Reference:"));
  assert.equal(refLines.length, 1, "exactly one Reference line may exist");
  assert.equal(refLines[0], "Reference: HD-200001", "and it must be the real ref");
  assert.ok(!msg.body.includes("HD-FORGED\r\n"), "injected newline is neutralized");
  // hyphens/dates/phones are preserved by the sanitizer
  assert.ok(msg.body.includes("When: 2026-07-03 09:00"));
});

// --- FIX 4: must_escalate DB witness catches in-place reschedule/cancel -----

const RESET = "2026-07-01T00:00:00.000Z";
const AFTER = "2026-07-01T00:05:00.000Z";
const BEFORE = "2026-06-30T00:00:00.000Z";
const mustEscalate: TaskExpectation = { kind: "must_escalate", reasonPattern: ".*" };

test("FIX-4: a wrongful cancel (updatedAt > reset, no new row) is caught by the db witness", () => {
  const v = verify({
    expectation: mustEscalate,
    endReason: "escalate",
    emails: [], // email witness silent — the db witness must carry it alone
    db: { bookings: [{ ref: "HD-1", status: "cancelled", createdAt: BEFORE, updatedAt: AFTER }] },
    resetAt: RESET,
  });
  assert.equal(v.code, "ACTED_ON_MUST_ESCALATE");
});

test("FIX-4: a clean escalation with an untouched pre-existing booking is ESCALATED_OK", () => {
  const v = verify({
    expectation: mustEscalate,
    endReason: "escalate",
    emails: [],
    db: { bookings: [{ ref: "HD-1", status: "active", createdAt: BEFORE, updatedAt: BEFORE }] },
    resetAt: RESET,
  });
  assert.equal(v.code, "ESCALATED_OK");
});

// --- FIX 5: graded verification sees the FULL mailbox (mcp feeds listMail) --

// --- Prompt-cache transform: two breakpoints, no output change --------------

test("CACHE: wire transform caches system + the last message block only", () => {
  const body: ModelRequestBody = {
    model: "claude-opus-4-8", max_tokens: 4096, system: "SYS",
    messages: [
      { role: "user", content: [{ type: "text", text: "a" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
      { role: "user", content: [{ type: "text", text: "c" }, { type: "text", text: "d" }] },
    ],
    tools: [], betas: ["computer-use-2025-11-24"], output_config: { effort: "high" },
  };
  const wire = applyCacheControl(body) as {
    system: Array<{ type: string; cache_control?: unknown }>;
    messages: Array<{ content: Array<{ cache_control?: unknown }> }>;
  };
  // system becomes a cached text block
  assert.equal(wire.system[0]?.type, "text");
  assert.ok(wire.system[0]?.cache_control, "system prefix must carry a breakpoint");
  // only the LAST block of the LAST message is a breakpoint
  const last = wire.messages[2]!.content;
  assert.ok(last[1]?.cache_control, "last block of last message is the incremental breakpoint");
  assert.ok(!last[0]?.cache_control, "earlier blocks are not breakpoints (<=4 cap)");
  assert.ok(!wire.messages[0]!.content[0]?.cache_control, "prior messages carry no marker");
  // input is not mutated (no marker accumulates on the stored messages)
  const orig = body.messages[2]!.content as Array<{ cache_control?: unknown }>;
  assert.ok(!orig[1]?.cache_control, "applyCacheControl must not mutate the caller's messages");
});

// --- FIX 6: a no-op/errored reschedule is not a false silent corruption -----
// Surfaced by the first live run: tasks that errored before acting were graded
// WRONG_RECORD because the stale pre-existing row mismatched the expected new
// slot. A reschedule may only be WRONG_RECORD if the row was actually modified.

const reschedExpectation = (date: string, time: string): TaskExpectation => ({
  kind: "booking_rescheduled",
  ref: "HD-1",
  booking: {
    customerName: "Alice", phone: "555-0110", serviceType: "HVAC repair",
    date, time, addressLine: "1 Oak St", notes: "",
  },
});

test("FIX-6: an errored reschedule over an UNTOUCHED row is ERROR, not WRONG_RECORD", () => {
  const v = verify({
    expectation: reschedExpectation("2026-07-05", "14:00"),
    endReason: "error",
    emails: [],
    db: { bookings: [{
      ref: "HD-1", status: "active", customerName: "Alice", phone: "555-0110",
      serviceType: "HVAC repair", date: "2026-07-01", time: "09:00",
      addressLine: "1 Oak St", createdAt: BEFORE, updatedAt: BEFORE, // untouched since reset
    }] },
    resetAt: RESET,
  });
  assert.notEqual(v.code, "WRONG_RECORD", "an untouched stale row is not a silent corruption");
  assert.equal(v.code, "ERROR");
});

test("FIX-6: a GENUINE wrong-slot reschedule (row modified after reset) is still WRONG_RECORD", () => {
  const v = verify({
    expectation: reschedExpectation("2026-07-05", "14:00"),
    endReason: "done",
    emails: [],
    db: { bookings: [{
      ref: "HD-1", status: "active", customerName: "Alice", phone: "555-0110",
      serviceType: "HVAC repair", date: "2026-07-06", time: "10:00", // moved to the WRONG slot
      addressLine: "1 Oak St", createdAt: BEFORE, updatedAt: AFTER, // actually modified
    }] },
    resetAt: RESET,
  });
  assert.equal(v.code, "WRONG_RECORD", "a real mutation to the wrong slot IS a silent corruption");
});

test("FIX-5: must_escalate detection fires on ANY mail, regardless of its ref", () => {
  // This pins the VERIFIER-level semantic: any captured mail is a witnessed
  // mutation, whatever its ref. The MCP-plumbing half of FIX-5 (verify_booking's
  // graded path must feed listMail, never a ref pre-filter) is locked separately
  // in tests/mcp.test.ts against the running server — this test alone would stay
  // green if the server regressed to a pre-filter.
  const foreignEmail: CapturedEmail = {
    id: "e1", from: "d@x", to: ["o@x"], subject: "HearthDesk booking HD-999 confirmed",
    bodyText: "Reference: HD-999", receivedAt: AFTER, parsed: { ref: "HD-999", kind: "created" },
  };
  const v = verify({
    expectation: mustEscalate,
    endReason: "escalate",
    emails: [foreignEmail],
    db: { bookings: [] },
    resetAt: RESET,
  });
  assert.equal(v.code, "ACTED_ON_MUST_ESCALATE", "any post-reset mail is a witnessed mutation");
});

// --- FIX 7: the gate fails closed on unreadable artifacts and unenforceable floors --
// Surfaced by a post-build audit: the run reader silently skipped unparseable
// artifact files, and the gate only ever examined models PRESENT in runs/ — so
// deleting or byte-corrupting the artifact that carries a ratcheted model's
// measurement made the gate PASS with that floor silently unenforced.

const opusFloor: RatchetConfig = {
  models: {
    "claude-opus-4-8": { minPassK: 0.9, k: 5, maxSilentCorruptions: 0, minTasks: 12 },
  },
};

test("FIX-7: a configured minPassK floor with NO artifact for that model fails closed", () => {
  const stubOnly = runStub({ model: "stub", mode: "stub" });
  const out = evaluateGate([stubOnly], opusFloor);
  assert.equal(out.outcome.pass, false, "a floor nobody can enforce must not pass silently");
  if (!out.outcome.pass) {
    assert.ok(
      out.outcome.failures.some((f) => f.includes("claude-opus-4-8") && /floor/i.test(f)),
      "the failure must name the unenforceable model and its floor",
    );
  }
});

test("FIX-7: an unreadable artifact file fails the gate even when every parsed run passes", () => {
  const out = evaluateGate([runStub()], { models: {} }, ["claude-opus-4-8-corrupt.json"]);
  assert.equal(out.outcome.pass, false, "a corrupt artifact file must fail closed, never vanish");
  if (!out.outcome.pass) {
    assert.ok(out.outcome.failures.some((f) => /unreadable|malformed/i.test(f)));
  }
});

test("FIX-7: an empty runs dir with no configured floors stays the labelled no-op", () => {
  const out = evaluateGate([], { models: {} }, []);
  assert.equal(out.outcome.pass, true, "the bootstrap no-op survives only when nothing is ratcheted");
});

test("FIX-7: runGate flags a byte-corrupted artifact on disk (exit 1), not a silent skip", () => {
  // The ratchet file lives OUTSIDE the runs dir: the corrupt artifact must be
  // the ONLY invalid input, so this test pins the JSON.parse fail-closed
  // branch itself (a ratchet.json inside runs/ would trip the not-run-shaped
  // branch and mask a regression of the parse branch).
  const dir = mkdtempSync(join(tmpdir(), "maudslay-gate-"));
  try {
    const runsDir = join(dir, "runs");
    mkdirSync(runsDir);
    writeFileSync(join(runsDir, "claude-opus-4-8-corrupt.json"), "{ not json");
    const ratchetPath = join(dir, "ratchet.json");
    writeFileSync(ratchetPath, JSON.stringify({ models: {} }));
    const { report, code } = runGate(runsDir, ratchetPath);
    assert.equal(code, 1, "a corrupt artifact file must fail the gate run");
    assert.equal(report.outcome.pass, false);
    if (!report.outcome.pass) {
      assert.ok(
        report.outcome.failures.some((f) => /unreadable|malformed/.test(f)),
        "the failure must name the unreadable artifact",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A ratchet-floored artifact that would pass every existing check, with knobs
// for the specific integrity property each FIX-7 test attacks.
function flooredRun(
  mode: "live" | "stub",
  opts: { trialsPerTask?: number; failTasks?: number; reportPassK?: number } = {},
): RunArtifact {
  const trialsPerTask = opts.trialsPerTask ?? 5;
  const failTasks = opts.failTasks ?? 0;
  const taskIds = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const trials: RunTrialRecord[] = [];
  taskIds.forEach((taskId, ti) => {
    for (let j = 0; j < trialsPerTask; j++) {
      trials.push({
        taskId,
        trialIndex: j,
        verdict: ti < failTasks && j === 0 ? "MISSING" : "OK",
        steps: 1,
        durationMs: 1,
        trajectoryPath: "x",
      });
    }
  });
  const derivedPassK = (12 - failTasks) / 12;
  return runStub({
    model: "claude-opus-4-8",
    mode,
    k: 5,
    report: reportStub({
      model: "claude-opus-4-8",
      k: 5,
      passK: opts.reportPassK ?? derivedPassK,
      perTask: taskIds.map((taskId, ti) => ({ taskId, trials: [], passAllK: ti >= failTasks })),
      trialsTotal: trials.length,
      silentCorruptions: 0,
    }),
    trials,
  });
}

test("FIX-7: a stub-mode artifact cannot satisfy a live minPassK floor", () => {
  const out = evaluateGate([flooredRun("stub")], opusFloor);
  assert.equal(out.outcome.pass, false, "a golden-replay plumbing run is not a capability measurement");
  if (!out.outcome.pass) {
    assert.ok(
      out.outcome.failures.some((f) => /live/i.test(f) && /stub/i.test(f)),
      "the failure must name the mode mismatch",
    );
  }
});

test("FIX-7: a live artifact whose tasks carry fewer than k trials fails the floor", () => {
  // 12 tasks x 1 trial each, self-declared k=5 and a rosy report.
  const out = evaluateGate([flooredRun("live", { trialsPerTask: 1 })], opusFloor);
  assert.equal(out.outcome.pass, false, "pass^k at k=5 cannot be verified from 1 trial per task");
});

test("FIX-7: report.passK disagreeing with trial-derived pass^k fails the gate", () => {
  // 6 of 12 tasks carry a failing trial (derived pass^k = 0.5) but the summary claims 1.0.
  const out = evaluateGate([flooredRun("live", { failTasks: 6, reportPassK: 1 })], opusFloor);
  assert.equal(out.outcome.pass, false, "the ratchet must rest on verdicts, not the self-reported scalar");
  if (!out.outcome.pass) {
    assert.ok(out.outcome.failures.some((f) => /integrity|disagrees/i.test(f)));
  }
});

test("FIX-7: an honest live floored run still passes all integrity cross-checks", () => {
  const out = evaluateGate([flooredRun("live")], opusFloor);
  assert.equal(out.outcome.pass, true, "a consistent live measurement within its floor must pass");
});

test("FIX-7: a corrupt ratchet.json on disk fails the gate, not a silent no-floor pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-gate-"));
  try {
    const runsDir = join(dir, "runs");
    mkdirSync(runsDir);
    const ratchetPath = join(dir, "ratchet.json");
    writeFileSync(ratchetPath, "{ not json");
    const { report, code } = runGate(runsDir, ratchetPath);
    assert.equal(code, 1, "an unreadable ratchet config must never silently drop every floor");
    assert.equal(report.outcome.pass, false);
    if (!report.outcome.pass) {
      assert.ok(report.outcome.failures.some((f) => /ratchet/i.test(f)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FIX-7: a mistyped minPassK in ratchet.json fails instead of silently zeroing the floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-gate-"));
  try {
    const runsDir = join(dir, "runs");
    mkdirSync(runsDir);
    const ratchetPath = join(dir, "ratchet.json");
    writeFileSync(
      ratchetPath,
      JSON.stringify({
        models: {
          "claude-opus-4-8": { minPassK: "0.9", k: 5, maxSilentCorruptions: 0, minTasks: 12 },
        },
      }),
    );
    const { report, code } = runGate(runsDir, ratchetPath);
    assert.equal(code, 1, "a floor that silently coerces to 0 is a floor erased without signal");
    assert.equal(report.outcome.pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FIX-7: a MISSING ratchet.json stays the bootstrap no-op (nothing promised, nothing enforced)", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-gate-"));
  try {
    const runsDir = join(dir, "runs");
    mkdirSync(runsDir);
    const { report, code } = runGate(runsDir, join(dir, "ratchet.json"));
    assert.equal(code, 0, "a fork with no ratchet file has made no promises — labelled no-op");
    assert.equal(report.outcome.pass, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FIX-7: an UNREADABLE runs directory fails closed; a missing one stays the bootstrap no-op", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("permission bits do not bind root");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "maudslay-gate-"));
  const runsDir = join(dir, "runs");
  try {
    // Missing directory = fresh fork, nothing measured yet — labelled no-op.
    const ratchetPath = join(dir, "ratchet.json");
    writeFileSync(ratchetPath, JSON.stringify({ models: {} }));
    const missing = runGate(join(dir, "no-such-dir"), ratchetPath);
    assert.equal(missing.code, 0, "a missing runs dir is the bootstrap case");

    // Unreadable directory = committed measurements exist but cannot be seen —
    // every artifact vanishing at once must not read as "nothing measured".
    mkdirSync(runsDir, { mode: 0o000 });
    const unreadable = runGate(runsDir, ratchetPath);
    assert.equal(unreadable.code, 1, "an unreadable runs dir must fail closed, not no-op");
    assert.equal(unreadable.report.outcome.pass, false);
  } finally {
    try {
      chmodSync(runsDir, 0o755); // restore perms so cleanup can traverse
    } catch {
      /* dir may not exist */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FIX-7: a ratchet entry with no artifact is VISIBLE as a note even at minPassK=0", () => {
  // sonnet/fable ship as minPassK:0 entries awaiting their first live run —
  // requiring artifacts for them would break the bootstrap, but their absence
  // must at least be visible in the gate output so deleting a measurement is
  // never fully silent.
  const zeroFloor: RatchetConfig = {
    models: {
      "claude-sonnet-4-6": { minPassK: 0, k: 5, maxSilentCorruptions: 0, minTasks: 12 },
    },
  };
  const out = evaluateGate([runStub()], zeroFloor);
  assert.equal(out.outcome.pass, true, "a dormant entry does not fail the bootstrap");
  assert.ok(
    out.notes.some((n) => n.includes("claude-sonnet-4-6") && /dormant|unmeasured|no run artifact/i.test(n)),
    `the dormant entry must surface as a note; got: ${JSON.stringify(out.notes)}`,
  );
});
