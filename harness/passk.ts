/**
 * pass^k and its confidence floor — the scientific core of the gate.
 *
 * Everything here is a pure function of already-collected verdicts, so it is
 * unit-testable against known values with no browser, sim, or network. Two
 * things matter and are held to a high bar:
 *
 *  1. pass^k (Anthropic's definition): the fraction of tasks for which ALL k
 *     independent trials succeeded. A single flaky failure sinks the task — that
 *     is the point of reporting pass^k rather than a per-trial average.
 *  2. the Clopper-Pearson (exact, Beta-quantile) 95% lower bound on the
 *     per-trial success probability. This is the honest "floor" a run supports;
 *     an approximate (normal/Wald) interval is wrong at the small-n, near-1
 *     regime these evals live in, so we compute the exact binomial interval.
 */

import type { VerdictCode, PassKReport } from "../src/types.ts";
import { isSuccess, isSilentCorruption } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Log-gamma (Lanczos) and the regularized incomplete beta function I_x(a,b).
// ---------------------------------------------------------------------------

const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(z: number): number {
  if (z < 0.5) {
    // reflection: Γ(z)Γ(1-z) = π / sin(πz)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = LANCZOS_C[0] as number;
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) {
    a += (LANCZOS_C[i] as number) / (x + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (Numerical Recipes `betacf`). */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b) ∈ [0,1], monotone increasing in x. */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  // Use the form that converges fastest for the given x.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/**
 * Inverse of I_x(a,b) in x for a target probability p, by bisection. I_x is
 * strictly increasing in x, so bisection is unconditionally convergent; ~60
 * halvings drive the bracket below 1e-15.
 */
export function invIncompleteBeta(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = incompleteBeta(mid, a, b);
    if (v < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-15) break;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Clopper-Pearson exact binomial interval.
// ---------------------------------------------------------------------------

/**
 * Exact (Clopper-Pearson) lower confidence limit for a binomial proportion:
 * s successes in n trials at two-sided confidence `conf` (default 0.95).
 * s = 0 has lower limit exactly 0. Otherwise it is the (α/2) quantile of
 * Beta(s, n-s+1).
 */
export function clopperPearsonLower(s: number, n: number, conf = 0.95): number {
  if (n <= 0) return 0;
  if (s <= 0) return 0;
  if (s >= n) {
    const alpha = 1 - conf;
    return invIncompleteBeta(alpha / 2, s, n - s + 1);
  }
  const alpha = 1 - conf;
  return invIncompleteBeta(alpha / 2, s, n - s + 1);
}

/**
 * Exact (Clopper-Pearson) upper confidence limit. s = n has upper limit exactly
 * 1. Otherwise it is the (1-α/2) quantile of Beta(s+1, n-s). Provided for
 * completeness and interval sanity checks.
 */
export function clopperPearsonUpper(s: number, n: number, conf = 0.95): number {
  if (n <= 0) return 1;
  if (s >= n) return 1;
  const alpha = 1 - conf;
  return invIncompleteBeta(1 - alpha / 2, s + 1, n - s);
}

// ---------------------------------------------------------------------------
// pass^k over per-task verdicts.
// ---------------------------------------------------------------------------

export interface TaskTrials {
  taskId: string;
  trials: VerdictCode[];
}

/** Per-trial success rate over a flat list of verdicts. */
export function perTrialPassRate(verdicts: VerdictCode[]): number {
  if (verdicts.length === 0) return 0;
  const s = verdicts.filter(isSuccess).length;
  return s / verdicts.length;
}

/** A task passes^k iff it has at least k trials and the first k all succeed. */
export function taskPassesK(trials: VerdictCode[], k: number): boolean {
  if (k <= 0) return false;
  if (trials.length < k) return false;
  return trials.slice(0, k).every(isSuccess);
}

/** Fraction of tasks that pass^k. */
export function passK(perTask: TaskTrials[], k: number): number {
  if (perTask.length === 0) return 0;
  const passed = perTask.filter((t) => taskPassesK(t.trials, k)).length;
  return passed / perTask.length;
}

interface FlatTrial {
  taskId: string;
  verdict: VerdictCode;
}

/**
 * Assemble the full PassKReport (src/types.ts) from a flat list of per-trial
 * verdicts. Trials are grouped by task in first-seen order; nothing is
 * fabricated — every number is derived from the verdicts passed in.
 */
export function buildPassKReport(
  model: string,
  k: number,
  trials: FlatTrial[],
  generatedAt: string,
): PassKReport {
  const order: string[] = [];
  const byTask = new Map<string, VerdictCode[]>();
  for (const t of trials) {
    let arr = byTask.get(t.taskId);
    if (!arr) {
      arr = [];
      byTask.set(t.taskId, arr);
      order.push(t.taskId);
    }
    arr.push(t.verdict);
  }

  const perTask = order.map((taskId) => {
    const trialsForTask = byTask.get(taskId) as VerdictCode[];
    return {
      taskId,
      trials: trialsForTask,
      passAllK: taskPassesK(trialsForTask, k),
    };
  });

  const allVerdicts = trials.map((t) => t.verdict);
  const successes = allVerdicts.filter(isSuccess).length;
  const trialsTotal = allVerdicts.length;
  const silentCorruptions = allVerdicts.filter(isSilentCorruption).length;
  const escalations = allVerdicts.filter(
    (v) => v === "ESCALATED_OK" || v === "ESCALATED_WRONG",
  ).length;

  return {
    model,
    k,
    generatedAt,
    perTask,
    passK: perTask.length === 0 ? 0 : perTask.filter((t) => t.passAllK).length / perTask.length,
    perTrialPassRate: trialsTotal === 0 ? 0 : successes / trialsTotal,
    perTrialLowerBound95: clopperPearsonLower(successes, trialsTotal),
    trialsTotal,
    silentCorruptions,
    escalationRate: trialsTotal === 0 ? 0 : escalations / trialsTotal,
  };
}
