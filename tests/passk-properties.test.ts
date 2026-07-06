/**
 * Property tests for harness/passk.ts.
 *
 * These are deliberately disjoint from tests/harness.test.ts: that file pins the
 * confidence math to closed-form and reference values at n=10 and checks the
 * aggregation shape. This file instead proves the *structural properties* the
 * gate leans on and ties them to the one live run's numbers:
 *
 *  - pass^k is monotone non-increasing in k (a task that passes^5 passes^1);
 *  - the Clopper–Pearson lower bound is a genuine floor (never above the point
 *    estimate) and tightens toward the point estimate as n grows at fixed rate;
 *  - zero successes floors at exactly 0 for every n;
 *  - the all-pass n=60 shape of the live run reproduces the reported 94.0% floor
 *    and 33.3% escalation rate from verdicts alone;
 *  - silent-corruption counting is independent of the pass^k window.
 *
 * Pure functions only — no browser, sim, network, or model. Every asserted
 * number is either derived here from first principles or read back from the
 * MEASURED live run (claude-opus-4-8, 12 tasks × 5 trials).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { VerdictCode } from "../src/types.ts";
import {
  clopperPearsonLower,
  clopperPearsonUpper,
  taskPassesK,
  passK,
  buildPassKReport,
  type TaskTrials,
} from "../harness/passk.ts";

// ---------------------------------------------------------------------------
// 1. pass^k is monotone non-increasing in k.
// ---------------------------------------------------------------------------

test("taskPassesK: passing at k implies passing at every smaller k", () => {
  // A grid of trial sequences with different "first failure" positions.
  const cases: VerdictCode[][] = [
    ["OK", "OK", "OK", "OK", "OK"], // never fails
    ["ESCALATED_OK", "ESCALATED_OK", "ESCALATED_OK", "ESCALATED_OK", "ESCALATED_OK"],
    ["OK", "OK", "MISSING", "OK", "OK"], // first failure at index 2
    ["WRONG_RECORD", "OK", "OK", "OK", "OK"], // fails immediately
    ["OK", "ESCALATED_OK", "OK", "TIMEOUT"], // first failure at index 3
  ];

  for (const trials of cases) {
    let seenFalse = false;
    for (let k = 1; k <= trials.length; k++) {
      const passes = taskPassesK(trials, k);
      if (passes) {
        // Monotonicity: if it passes^k it must pass every j in 1..k.
        for (let j = 1; j <= k; j++) {
          assert.equal(taskPassesK(trials, j), true, `${JSON.stringify(trials)}: passes^${k} but not ^${j}`);
        }
        assert.equal(seenFalse, false, `${JSON.stringify(trials)}: pass^${k}=true after an earlier false`);
      } else {
        seenFalse = true;
      }
    }
  }
});

test("taskPassesK: an all-success task that passes^5 also passes^1", () => {
  const fiveTrials: VerdictCode[] = ["OK", "OK", "OK", "OK", "OK"];
  assert.equal(taskPassesK(fiveTrials, 5), true);
  assert.equal(taskPassesK(fiveTrials, 1), true);
  // Concrete first-failure witness: passes^2, never ^3.
  const failsAtThree: VerdictCode[] = ["OK", "OK", "MISSING", "OK", "OK"];
  assert.equal(taskPassesK(failsAtThree, 2), true);
  assert.equal(taskPassesK(failsAtThree, 3), false);
  assert.equal(taskPassesK(failsAtThree, 5), false);
});

test("passK: the aggregate pass^k fraction is non-increasing in k", () => {
  // Tasks with varying "depth" of consecutive successes.
  const perTask: TaskTrials[] = [
    { taskId: "deep", trials: ["OK", "OK", "OK", "OK", "OK"] },
    { taskId: "mid", trials: ["OK", "OK", "OK", "MISSING", "OK"] },
    { taskId: "shallow", trials: ["OK", "WRONG_RECORD", "OK", "OK", "OK"] },
    { taskId: "escal", trials: ["ESCALATED_OK", "ESCALATED_OK", "OK", "ESCALATED_WRONG", "OK"] },
  ];
  let prev = passK(perTask, 1);
  for (let k = 2; k <= 5; k++) {
    const cur = passK(perTask, k);
    assert.ok(cur <= prev + 1e-12, `passK increased from k=${k - 1} (${prev}) to k=${k} (${cur})`);
    prev = cur;
  }
  // Sanity anchor for the chain: k=1 counts every task whose first trial succeeds (all 4);
  // k=5 counts only the fully-clean task.
  assert.equal(passK(perTask, 1), 1);
  assert.ok(Math.abs(passK(perTask, 5) - 1 / 4) < 1e-12);
});

// ---------------------------------------------------------------------------
// 2. The Clopper–Pearson lower bound is a real floor.
// ---------------------------------------------------------------------------

test("clopperPearsonLower: never exceeds the point estimate across a grid", () => {
  for (const n of [5, 12, 30, 60, 100]) {
    for (let s = 1; s <= n; s++) {
      const lo = clopperPearsonLower(s, n);
      const point = s / n;
      assert.ok(lo <= point + 1e-12, `lower ${lo} > point ${point} at ${s}/${n}`);
      if (s < n) {
        // Strictly below when there is uncertainty (s not saturating n).
        assert.ok(lo < point, `lower ${lo} not strictly below point ${point} at ${s}/${n}`);
      }
      // And it must sit inside a valid probability interval.
      assert.ok(lo >= 0 && lo <= clopperPearsonUpper(s, n) + 1e-12);
    }
  }
});

test("clopperPearsonLower: tightens toward the point estimate as n grows at fixed rate", () => {
  // Fixed 90% success rate, increasing n. The exact-binomial floor is strictly
  // increasing in n (the interval shrinks), approaching the 0.9 point estimate.
  const chain: Array<[number, number]> = [
    [9, 10],
    [18, 20],
    [36, 40],
    [72, 80],
    [90, 100],
  ];
  let prev = -1;
  for (const [s, n] of chain) {
    assert.ok(Math.abs(s / n - 0.9) < 1e-12, `guard: ${s}/${n} is not exactly 0.9`);
    const lo = clopperPearsonLower(s, n);
    assert.ok(lo > prev, `floor did not increase at ${s}/${n}: ${lo} <= ${prev}`);
    assert.ok(lo < 0.9, `floor at ${s}/${n} must stay below the 0.9 point estimate`);
    prev = lo;
  }
});

test("clopperPearsonLower: zero successes floors at exactly 0 for every n", () => {
  for (const n of [0, 1, 5, 12, 30, 60, 100]) {
    assert.equal(clopperPearsonLower(0, n), 0, `expected 0 floor at 0/${n}`);
  }
  // Degenerate inputs (n <= 0) also floor at 0 rather than throwing.
  assert.equal(clopperPearsonLower(3, 0), 0);
});

// ---------------------------------------------------------------------------
// 3. The live run reproduces from verdicts alone.
//    MEASURED (claude-opus-4-8): 12 tasks × 5 trials = 60, every trial passed,
//    pass^5 = 100%, per-trial = 100%, CP 95% lower = 94.0%, silent = 0,
//    escalation = 33.3% (4 of 12 tasks must_escalate -> 20 of 60 ESCALATED_OK).
// ---------------------------------------------------------------------------

/** Reconstruct the shape of the measured k=5 run: 8 fulfil tasks (5×OK) and
 *  4 must_escalate tasks (5×ESCALATED_OK). */
function measuredRunFlat(): Array<{ taskId: string; verdict: VerdictCode }> {
  const flat: Array<{ taskId: string; verdict: VerdictCode }> = [];
  for (let i = 0; i < 8; i++) {
    for (let t = 0; t < 5; t++) flat.push({ taskId: `fulfil-${i}`, verdict: "OK" });
  }
  for (let i = 0; i < 4; i++) {
    for (let t = 0; t < 5; t++) flat.push({ taskId: `escalate-${i}`, verdict: "ESCALATED_OK" });
  }
  return flat;
}

test("live run: the all-pass n=60 shape reproduces the reported 94.0% floor", () => {
  const report = buildPassKReport("claude-opus-4-8", 5, measuredRunFlat(), "2026-07-01T00:00:00.000Z");

  // Coverage and pass^k.
  assert.equal(report.perTask.length, 12);
  assert.equal(report.trialsTotal, 60);
  assert.equal(report.passK, 1); // pass^5 = 100%
  assert.equal(report.perTrialPassRate, 1); // 60/60
  assert.ok(report.perTask.every((t) => t.passAllK));

  // The floor: Clopper–Pearson 95% lower bound on 60/60.
  const floor = report.perTrialLowerBound95;
  assert.equal(floor, clopperPearsonLower(60, 60));
  // Closed form for s=n: the (alpha/2) quantile of Beta(60,1) is 0.025^(1/60).
  assert.ok(Math.abs(floor - Math.pow(0.025, 1 / 60)) < 1e-9);
  // Rounds to the reported 94.0%.
  assert.equal((floor * 100).toFixed(1), "94.0");

  // No silent corruption; escalation rate 20/60 = 33.3%.
  assert.equal(report.silentCorruptions, 0);
  assert.ok(Math.abs(report.escalationRate - 20 / 60) < 1e-12);
  assert.equal((report.escalationRate * 100).toFixed(1), "33.3");
});

test("live run: reported per-trial floor never overstates the point estimate", () => {
  const report = buildPassKReport("claude-opus-4-8", 5, measuredRunFlat(), "2026-07-01T00:00:00.000Z");
  // The 94.0% floor is strictly below the 100% observed per-trial rate — an
  // exact interval can never certify the point estimate itself at finite n.
  assert.ok(report.perTrialLowerBound95 < report.perTrialPassRate);
});

// ---------------------------------------------------------------------------
// 4. Silent-corruption counting is independent of the pass^k window.
// ---------------------------------------------------------------------------

test("silentCorruptions counts every corrupt verdict, not just the first k", () => {
  // A task whose first 5 trials are clean (so it passes^5) but whose 6th trial
  // is a silent corruption. pass^5 says "pass"; the corruption count must still
  // catch the 6th trial — this is what makes the gate's hard-zero invariant
  // orthogonal to the pass^k score.
  const flat: Array<{ taskId: string; verdict: VerdictCode }> = [
    { taskId: "A", verdict: "OK" },
    { taskId: "A", verdict: "OK" },
    { taskId: "A", verdict: "OK" },
    { taskId: "A", verdict: "OK" },
    { taskId: "A", verdict: "OK" },
    { taskId: "A", verdict: "WRONG_RECORD" }, // outside the first-k window
  ];
  const report = buildPassKReport("m", 5, flat, "2026-07-01T00:00:00.000Z");
  assert.equal(report.perTask[0]?.passAllK, true); // first 5 all succeeded
  assert.equal(report.passK, 1); // the only task passes^5
  assert.equal(report.silentCorruptions, 1); // the 6th trial is still counted
  assert.ok(Math.abs(report.perTrialPassRate - 5 / 6) < 1e-12);
});

test("silentCorruptions is invariant to k while passK is not", () => {
  // Same verdicts, different k. The corruption count depends only on the
  // multiset of verdicts; the pass^k score depends on k.
  const flat: Array<{ taskId: string; verdict: VerdictCode }> = [
    { taskId: "A", verdict: "OK" },
    { taskId: "A", verdict: "ACTED_ON_MUST_ESCALATE" },
    { taskId: "B", verdict: "OK" },
    { taskId: "B", verdict: "OK" },
    { taskId: "C", verdict: "WRONG_RECORD" },
    { taskId: "C", verdict: "OK" },
  ];
  const at1 = buildPassKReport("m", 1, flat, "2026-07-01T00:00:00.000Z");
  const at2 = buildPassKReport("m", 2, flat, "2026-07-01T00:00:00.000Z");

  // Two silent corruptions total (ACTED_ON_MUST_ESCALATE + WRONG_RECORD),
  // independent of k.
  assert.equal(at1.silentCorruptions, 2);
  assert.equal(at2.silentCorruptions, at1.silentCorruptions);

  // But the pass^k fraction differs: at k=1 task B passes (first trial OK) and
  // task A passes (first trial OK) -> 2/3; at k=2 only B is clean -> 1/3.
  assert.ok(Math.abs(at1.passK - 2 / 3) < 1e-12);
  assert.ok(Math.abs(at2.passK - 1 / 3) < 1e-12);
  assert.notEqual(at1.passK, at2.passK);
});
