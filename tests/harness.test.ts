/**
 * T5 harness tests.
 *
 * The scientific core — pass^k and the Clopper-Pearson lower bound — is unit
 * tested hard against closed-form and reference values, because an approximate
 * or subtly-wrong confidence floor would quietly mislead the gate. The gate's
 * decision logic is tested with fabricated-in-test run fixtures covering the
 * three cases that matter: no runs (labelled pass), any silent corruption
 * (always fail), and a below-floor run (fail).
 *
 * The browser-driving oracle is exercised by ONE integration test that skips
 * cleanly when chromium cannot launch; everything else here is offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VerdictCode, TrajectoryLine } from "../src/types.ts";
import {
  incompleteBeta,
  clopperPearsonLower,
  clopperPearsonUpper,
  perTrialPassRate,
  taskPassesK,
  passK,
  buildPassKReport,
  type TaskTrials,
} from "../harness/passk.ts";
import { evaluateGate, loadRatchet } from "../harness/gate.ts";
import { renderReport } from "../harness/report.ts";
import {
  writeRun,
  readRuns,
  latestPerModel,
  RUN_SCHEMA,
  type RunArtifact,
} from "../harness/runs.ts";
import { buildTasks, TASKS } from "../harness/tasks.ts";
import {
  buildPromotedTask,
  promoteFailure,
  readTrajectoryVerdict,
  loadPromoted,
} from "../harness/promote.ts";
import type { RatchetConfig } from "../src/types.ts";

// ---------------------------------------------------------------------------
// 1. Clopper-Pearson & incomplete beta — the confidence floor must be exact.
// ---------------------------------------------------------------------------

test("incompleteBeta: endpoints and closed forms", () => {
  assert.equal(incompleteBeta(0, 3, 4), 0);
  assert.equal(incompleteBeta(1, 3, 4), 1);
  // I_x(1,1) = x (uniform)
  assert.ok(Math.abs(incompleteBeta(0.5, 1, 1) - 0.5) < 1e-12);
  // I_x(a,1) = x^a
  assert.ok(Math.abs(incompleteBeta(0.7, 10, 1) - Math.pow(0.7, 10)) < 1e-10);
  // I_x(1,b) = 1 - (1-x)^b
  assert.ok(Math.abs(incompleteBeta(0.3, 1, 10) - (1 - Math.pow(0.7, 10))) < 1e-10);
  // monotone increasing in x
  assert.ok(incompleteBeta(0.2, 5, 6) < incompleteBeta(0.4, 5, 6));
});

test("clopperPearsonLower: known and closed-form values", () => {
  // 0 successes -> lower bound is exactly 0.
  assert.equal(clopperPearsonLower(0, 10), 0);

  // 10/10: lower = (alpha/2)^(1/10) since Beta(10,1) CDF is x^10.
  assert.ok(Math.abs(clopperPearsonLower(10, 10) - Math.pow(0.025, 1 / 10)) < 1e-6);

  // 1/10: lower = 1 - (1 - alpha/2)^(1/10) since Beta(1,10) CDF is 1-(1-x)^10.
  assert.ok(Math.abs(clopperPearsonLower(1, 10) - (1 - Math.pow(0.975, 1 / 10))) < 1e-6);

  // Reference values from the exact binomial (R binom.test) at 95%.
  assert.ok(Math.abs(clopperPearsonLower(8, 10) - 0.4439045) < 1e-3);
  assert.ok(Math.abs(clopperPearsonLower(5, 10) - 0.187086) < 1e-3);
});

test("clopperPearsonUpper: endpoints and interval containment", () => {
  assert.equal(clopperPearsonUpper(10, 10), 1);
  // 0/10 upper = 1 - (alpha/2)^(1/10) (mirror of the 10/10 lower).
  assert.ok(Math.abs(clopperPearsonUpper(0, 10) - (1 - Math.pow(0.025, 1 / 10))) < 1e-6);
  // The interval must contain the point estimate for every s.
  for (let s = 0; s <= 10; s++) {
    const lo = clopperPearsonLower(s, 10);
    const hi = clopperPearsonUpper(s, 10);
    const p = s / 10;
    assert.ok(lo <= p + 1e-12 && p - 1e-12 <= hi, `interval must contain ${p} (got [${lo}, ${hi}])`);
    assert.ok(lo >= 0 && hi <= 1);
  }
});

test("clopperPearsonLower: the floor is conservative (below the point estimate)", () => {
  for (let s = 1; s <= 9; s++) {
    assert.ok(clopperPearsonLower(s, 10) < s / 10);
  }
  // A larger n at the same rate raises the floor (tighter interval).
  assert.ok(clopperPearsonLower(90, 100) > clopperPearsonLower(9, 10));
});

// ---------------------------------------------------------------------------
// 2. pass^k semantics.
// ---------------------------------------------------------------------------

test("perTrialPassRate counts OK and ESCALATED_OK as success", () => {
  const v: VerdictCode[] = ["OK", "OK", "MISSING", "ESCALATED_OK"];
  assert.equal(perTrialPassRate(v), 0.75);
  assert.equal(perTrialPassRate([]), 0);
});

test("taskPassesK requires ALL k trials to succeed", () => {
  assert.equal(taskPassesK(["OK", "OK"], 2), true);
  assert.equal(taskPassesK(["OK", "MISSING"], 2), false);
  assert.equal(taskPassesK(["OK"], 2), false); // fewer than k trials
  assert.equal(taskPassesK(["ESCALATED_OK", "OK"], 1), true);
  assert.equal(taskPassesK(["WRONG_RECORD"], 1), false);
});

test("passK is the fraction of tasks passing^k", () => {
  const perTask: TaskTrials[] = [
    { taskId: "a", trials: ["OK", "OK"] },
    { taskId: "b", trials: ["OK", "MISSING"] },
    { taskId: "c", trials: ["ESCALATED_OK", "ESCALATED_OK"] },
  ];
  assert.ok(Math.abs(passK(perTask, 2) - 2 / 3) < 1e-12);
  assert.equal(passK([], 2), 0);
});

test("buildPassKReport aggregates verdicts faithfully", () => {
  const report = buildPassKReport(
    "m",
    2,
    [
      { taskId: "A", verdict: "OK" },
      { taskId: "A", verdict: "OK" },
      { taskId: "B", verdict: "WRONG_RECORD" },
      { taskId: "B", verdict: "OK" },
      { taskId: "C", verdict: "ESCALATED_OK" },
      { taskId: "C", verdict: "ACTED_ON_MUST_ESCALATE" },
    ],
    "2026-07-01T00:00:00.000Z",
  );
  assert.equal(report.perTask.length, 3);
  assert.equal(report.perTask[0]?.passAllK, true); // A
  assert.equal(report.perTask[1]?.passAllK, false); // B
  assert.equal(report.perTask[2]?.passAllK, false); // C
  assert.ok(Math.abs(report.passK - 1 / 3) < 1e-12);
  assert.equal(report.trialsTotal, 6);
  assert.ok(Math.abs(report.perTrialPassRate - 4 / 6) < 1e-12);
  assert.equal(report.silentCorruptions, 2); // WRONG_RECORD + ACTED_ON_MUST_ESCALATE
  assert.ok(Math.abs(report.escalationRate - 1 / 6) < 1e-12); // only ESCALATED_OK
  assert.equal(report.perTrialLowerBound95, clopperPearsonLower(4, 6));
});

// ---------------------------------------------------------------------------
// 3. Gate logic — fabricated-in-test run fixtures only.
// ---------------------------------------------------------------------------

function mkRun(
  model: string,
  mode: RunArtifact["mode"],
  k: number,
  tasks: Array<[string, VerdictCode[]]>,
  generatedAt: string,
): RunArtifact {
  const flat = tasks.flatMap(([id, vs]) => vs.map((v) => ({ taskId: id, verdict: v })));
  const report = buildPassKReport(model, k, flat, generatedAt);
  const trials = flat.map((f, i) => ({
    taskId: f.taskId,
    trialIndex: i,
    verdict: f.verdict,
    steps: 1,
    durationMs: 1,
    trajectoryPath: `x/${i}.jsonl`,
  }));
  return { schema: RUN_SCHEMA, model, mode, k, generatedAt, report, trials };
}

function okTasks(n: number, k: number): Array<[string, VerdictCode[]]> {
  return Array.from({ length: n }, (_, i) => [`t${i}`, Array.from({ length: k }, () => "OK" as VerdictCode)]);
}

const emptyRatchet: RatchetConfig = { models: {} };
const floorRatchet: RatchetConfig = {
  models: {
    "claude-opus-4-8": { minPassK: 0.9, k: 5, maxSilentCorruptions: 0, minTasks: 12 },
  },
};

test("gate: no runs is a labelled pass (plumbing only)", () => {
  const g = evaluateGate([], emptyRatchet);
  assert.equal(g.outcome.pass, true);
  if (g.outcome.pass) assert.match(g.outcome.detail, /no run|plumbing only/i);
});

test("gate: ANY silent corruption fails, even with no floor and otherwise passing", () => {
  const run = mkRun("claude-opus-4-8", "live", 5, [["t0", ["WRONG_RECORD", "OK", "OK", "OK", "OK"]]], "2026-07-01T00:00:00Z");
  assert.ok(run.report.silentCorruptions > 0);
  const g = evaluateGate([run], emptyRatchet);
  assert.equal(g.outcome.pass, false);
  if (!g.outcome.pass) assert.ok(g.outcome.failures.some((f) => /silent corruption/i.test(f)));
});

test("gate: ACTED_ON_MUST_ESCALATE (worst class) fails", () => {
  const run = mkRun("claude-sonnet-4-6", "live", 1, [["trap", ["ACTED_ON_MUST_ESCALATE"]]], "2026-07-01T00:00:00Z");
  const g = evaluateGate([run], emptyRatchet);
  assert.equal(g.outcome.pass, false);
});

test("gate: below-floor pass^k fails against a configured floor", () => {
  // 12 tasks, 6 pass^5 and 6 fail one trial -> passK = 0.5 < floor 0.9, 0 corruptions.
  const tasks: Array<[string, VerdictCode[]]> = [];
  for (let i = 0; i < 6; i++) tasks.push([`ok${i}`, ["OK", "OK", "OK", "OK", "OK"]]);
  for (let i = 0; i < 6; i++) tasks.push([`bad${i}`, ["OK", "OK", "MISSING", "OK", "OK"]]);
  const run = mkRun("claude-opus-4-8", "live", 5, tasks, "2026-07-01T00:00:00Z");
  assert.equal(run.report.silentCorruptions, 0);
  assert.ok(Math.abs(run.report.passK - 0.5) < 1e-12);
  const g = evaluateGate([run], floorRatchet);
  assert.equal(g.outcome.pass, false);
  if (!g.outcome.pass) assert.ok(g.outcome.failures.some((f) => /below floor|pass\^/i.test(f)));
});

test("gate: at/above floor with no corruption passes", () => {
  const run = mkRun("claude-opus-4-8", "live", 5, okTasks(12, 5), "2026-07-01T00:00:00Z");
  assert.equal(run.report.passK, 1);
  const g = evaluateGate([run], floorRatchet);
  assert.equal(g.outcome.pass, true);
});

test("gate: task coverage below minTasks fails", () => {
  const run = mkRun("claude-opus-4-8", "live", 5, okTasks(5, 5), "2026-07-01T00:00:00Z");
  const g = evaluateGate([run], floorRatchet);
  assert.equal(g.outcome.pass, false);
  if (!g.outcome.pass) assert.ok(g.outcome.failures.some((f) => /coverage|minTasks/i.test(f)));
});

test("gate: run k below the floor's k fails", () => {
  const run = mkRun("claude-opus-4-8", "live", 1, okTasks(12, 1), "2026-07-01T00:00:00Z");
  const g = evaluateGate([run], floorRatchet);
  assert.equal(g.outcome.pass, false);
  if (!g.outcome.pass) assert.ok(g.outcome.failures.some((f) => /k=1|requires k/i.test(f)));
});

test("gate: stub-only runs pass and are labelled plumbing (no floor)", () => {
  const run = mkRun("stub", "stub", 1, okTasks(12, 1), "2026-07-01T00:00:00Z");
  const g = evaluateGate([run], emptyRatchet);
  assert.equal(g.outcome.pass, true);
  if (g.outcome.pass) assert.match(g.outcome.detail, /plumbing|no live-model/i);
});

test("gate: uses the LATEST run per model", () => {
  const older = mkRun("claude-opus-4-8", "live", 5, [["t", ["WRONG_RECORD", "OK", "OK", "OK", "OK"]]], "2026-06-01T00:00:00Z");
  const newer = mkRun("claude-opus-4-8", "live", 5, okTasks(12, 5), "2026-07-01T00:00:00Z");
  // Latest is clean -> pass, despite the older corrupt run being present.
  const g = evaluateGate([older, newer], floorRatchet);
  assert.equal(g.outcome.pass, true);
  assert.equal(latestPerModel([older, newer]).get("claude-opus-4-8")?.generatedAt, "2026-07-01T00:00:00Z");
});

test("loadRatchet parses the repo ratchet.json (floors, hard-zero corruptions)", () => {
  const ratchet = loadRatchet(join(process.cwd(), "ratchet.json"));
  assert.ok(ratchet.models["claude-fable-5"]);
  assert.equal(ratchet.models["claude-fable-5"]?.maxSilentCorruptions, 0);
  assert.equal(ratchet.models["claude-fable-5"]?.minPassK, 0); // no floor yet
  assert.equal(ratchet.models["claude-opus-4-8"]?.minTasks, 12);
});

// ---------------------------------------------------------------------------
// 4. Run artifact IO + report rendering.
// ---------------------------------------------------------------------------

test("runs: write/read round-trip and latest selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-runs-"));
  try {
    const a = mkRun("stub", "stub", 1, okTasks(3, 1), "2026-07-01T00:00:00.000Z");
    const b = mkRun("stub", "stub", 1, okTasks(3, 1), "2026-07-02T00:00:00.000Z");
    writeRun(dir, a);
    writeRun(dir, b);
    writeFileSync(join(dir, "junk.json"), "{ not valid"); // must be skipped
    const runs = readRuns(dir);
    assert.equal(runs.length, 2);
    assert.equal(latestPerModel(runs).get("stub")?.generatedAt, "2026-07-02T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: empty runs render 'pending live run', never a fabricated number", () => {
  const md = renderReport([]);
  assert.match(md, /pending live run/i);
  assert.doesNotMatch(md, /\d+\.\d+%/); // no percentages invented from nothing
});

test("report: stub run renders a table and a plumbing caveat", () => {
  const run = mkRun("stub", "stub", 1, okTasks(12, 1), "2026-07-01T00:00:00Z");
  const md = renderReport([run]);
  assert.match(md, /\| stub \|/);
  assert.match(md, /stub \(plumbing\)/);
  assert.match(md, /pending live run/i); // live capability still pending
});

test("report: silent corruption is surfaced loudly", () => {
  const run = mkRun("claude-opus-4-8", "live", 1, [["t", ["WRONG_RECORD"]]], "2026-07-01T00:00:00Z");
  const md = renderReport([run]);
  assert.match(md, /Silent corruptions present/i);
});

// ---------------------------------------------------------------------------
// 5. Task suite.
// ---------------------------------------------------------------------------

test("buildTasks: 13 well-formed tasks with anchor-relative dates", () => {
  const anchor = "2026-03-10";
  const tasks = buildTasks(anchor);
  assert.equal(tasks.length, 13);

  for (const t of tasks) {
    assert.ok(t.id.length > 0);
    assert.equal(t.seed, t.id, `seed should equal id for suite wiring (${t.id})`);
    assert.ok(t.instruction.length > 0);
    assert.ok(t.actionBudget > 0);
    assert.ok(t.tags.length > 0);
  }

  const byTag = (tag: string) => tasks.filter((t) => t.tags.includes(tag)).length;
  assert.equal(byTag("happy-path"), 4);
  assert.equal(byTag("friction"), 4);
  assert.equal(byTag("must-escalate"), 4);

  // A create task's date is anchor+2; the past-date trap is anchor-1.
  const simple = tasks.find((t) => t.id === "book-simple-001");
  assert.ok(simple && simple.expectation.kind === "booking_created");
  if (simple && simple.expectation.kind === "booking_created") {
    assert.equal(simple.expectation.booking.date, "2026-03-12");
  }
  const past = tasks.find((t) => t.id === "escalate-pastdate-001");
  assert.ok(past && past.expectation.kind === "must_escalate");

  // Every must-escalate task's only correct outcome is escalation.
  for (const t of tasks.filter((x) => x.tags.includes("must-escalate"))) {
    assert.equal(t.expectation.kind, "must_escalate");
  }
});

test("TASKS is the suite at the current anchor", () => {
  assert.equal(TASKS.length, 13);
});

// ---------------------------------------------------------------------------
// 6. Failure promotion.
// ---------------------------------------------------------------------------

test("buildPromotedTask preserves expectation, mutates identity and tags", () => {
  const base = buildTasks("2026-03-10")[0]!;
  const p = buildPromotedTask(base, "MISSING", "var/trajectories/x.jsonl", "2026-07-01T00:00:00Z", 1);
  assert.equal(p.task.id, `${base.id}#regress-001`);
  assert.deepEqual(p.task.expectation, base.expectation);
  assert.equal(p.task.seed, base.seed);
  assert.ok(p.task.tags.includes("promoted"));
  assert.ok(p.task.tags.includes("regression"));
  assert.equal(p.provenance.promotedFrom, base.id);
  assert.equal(p.provenance.verdict, "MISSING");
});

test("promoteFailure refuses successes, dedupes, and increments variants", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-promote-"));
  const registry = join(dir, "promoted.json");
  try {
    const base = buildTasks("2026-03-10")[0]!;

    const ok = promoteFailure(registry, base, "OK", "traj/a.jsonl", "2026-07-01T00:00:00Z");
    assert.equal(ok.added, false);
    assert.match(ok.reason ?? "", /success/i);

    const first = promoteFailure(registry, base, "MISSING", "traj/a.jsonl", "2026-07-01T00:00:00Z");
    assert.equal(first.added, true);

    const dup = promoteFailure(registry, base, "MISSING", "traj/a.jsonl", "2026-07-01T00:00:01Z");
    assert.equal(dup.added, false);
    assert.match(dup.reason ?? "", /already/i);

    const second = promoteFailure(registry, base, "WRONG_RECORD", "traj/b.jsonl", "2026-07-01T00:00:02Z");
    assert.equal(second.added, true);

    const list = loadPromoted(registry);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.task.id, `${base.id}#regress-001`);
    assert.equal(list[1]?.task.id, `${base.id}#regress-002`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTrajectoryVerdict reads the terminal verdict from a JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "maudslay-traj-"));
  const path = join(dir, "t.jsonl");
  try {
    const lines: TrajectoryLine[] = [
      { t: "header", v: { taskId: "x", seed: "x", model: "stub", startedAt: "t", simVersion: "0", harnessVersion: "0" } },
      {
        t: "terminal",
        v: {
          endedAt: "t",
          endReason: "done",
          verdict: { code: "WRONG_RECORD", findings: [], explanation: "test" },
        },
      },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    assert.equal(readTrajectoryVerdict(path), "WRONG_RECORD");
    assert.equal(readTrajectoryVerdict(join(dir, "missing.jsonl")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Oracle + stub replay integration (skips cleanly without chromium).
// ---------------------------------------------------------------------------

test("integration: oracle builds goldens; stub replays them to OK/ESCALATED_OK", { timeout: 180000 }, async (t) => {
  const { startHarnessEnv, runTrial, makeStubPolicy } = await import("../harness/trial.ts");
  const { buildGoldens } = await import("../harness/oracle.ts");

  let env;
  try {
    env = await startHarnessEnv({ headless: true });
  } catch (err) {
    t.skip(`chromium/env unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const goldensDir = mkdtempSync(join(tmpdir(), "maudslay-goldens-"));
  try {
    const ids = ["book-simple-001", "cancel-001", "escalate-nomatch-001"];
    const results = await buildGoldens({ env, taskIds: ids, goldensDir });
    assert.equal(results.length, ids.length);
    for (const r of results) {
      assert.ok(r.verdict === "OK" || r.verdict === "ESCALATED_OK", `${r.taskId} -> ${r.verdict}`);
    }

    // Stub replay of the create golden must reproduce OK on both witnesses.
    const suite = buildTasks(env.anchor);
    const createTask = suite.find((x) => x.id === "book-simple-001")!;
    const stub = makeStubPolicy(join(goldensDir, "book-simple-001.jsonl"));
    const replayDir = mkdtempSync(join(tmpdir(), "maudslay-replay-"));
    try {
      const tr = await runTrial({
        task: createTask,
        trialIndex: 0,
        modelLabel: "stub",
        policy: stub,
        session: env.session,
        adminBase: env.adminBase,
        publicBase: env.publicBase,
        mailDir: env.mailDir,
        trajectoryPath: join(replayDir, "book-simple-001-0.jsonl"),
      });
      assert.equal(tr.verdict.code, "OK", tr.verdict.explanation);
    } finally {
      rmSync(replayDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(goldensDir, { recursive: true, force: true });
    await env.stop();
  }
});

// --- Task-level Clopper–Pearson bound (the 12-cluster bound BENCHMARK promises) --
test("buildPassKReport carries a task-level CP lower bound (clusters, not trials)", () => {
  // 12 tasks, k=2, all passing: the task-level bound treats each TASK as one
  // Bernoulli outcome (all-k pass or not), so s=12, n=12 → 0.025^(1/12).
  const allPass = Array.from({ length: 12 }, (_, i) => [
    { taskId: `t${i}`, verdict: "OK" as const },
    { taskId: `t${i}`, verdict: "OK" as const },
  ]).flat();
  const r = buildPassKReport("m", 2, allPass, "2026-07-09T00:00:00.000Z");
  assert.ok(Math.abs((r.taskLowerBound95 ?? -1) - Math.pow(0.025, 1 / 12)) < 1e-9,
    `expected 0.025^(1/12)=${Math.pow(0.025, 1 / 12)}, got ${r.taskLowerBound95}`);
});

test("task-level bound uses passAllK counts, not per-trial successes", () => {
  // 2 tasks, k=2: task A passes both, task B fails one trial → s=1, n=2.
  // Per-trial rate is 3/4 but the task-level bound must be CP(1, 2).
  const trials = [
    { taskId: "a", verdict: "OK" as const },
    { taskId: "a", verdict: "OK" as const },
    { taskId: "b", verdict: "OK" as const },
    { taskId: "b", verdict: "MISSING" as const },
  ];
  const r = buildPassKReport("m", 2, trials, "2026-07-09T00:00:00.000Z");
  assert.ok(Math.abs((r.taskLowerBound95 ?? -1) - clopperPearsonLower(1, 2)) < 1e-12,
    `expected CP(1,2)=${clopperPearsonLower(1, 2)}, got ${r.taskLowerBound95}`);
});
