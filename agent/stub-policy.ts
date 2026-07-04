/**
 * Deterministic replay policy. Given a golden trajectory's action sequence, it
 * emits those CUActions in order against the executor with NO model call and NO
 * pixel matching: the sim is deterministic, so replaying the recorded actions
 * reproduces the recorded outcome. Screenshot-hash drift is RECORDED (for
 * regression visibility) but never fails the replay — it is not a gate.
 *
 * Because it drives the same executor surface as the live loop, a stub replay
 * is a plumbing regression check over the harness + sim determinism, not a
 * model-capability claim.
 */

import type { CUAction } from '../src/types.ts';
import type { ExecutorLike, EndReason } from './loop.ts';

export interface ReplayStep {
  action: CUAction;
  /**
   * Observation hash recorded BEFORE this action in the golden
   * (`TrajectoryStep.obs.screenshotSha256`). Optional; when present the replay
   * compares it to the hash it currently holds and records any difference.
   */
  beforeSha256?: string;
}

export interface DriftRecord {
  /** index into the replayed action sequence where the drift was observed. */
  stepIndex: number;
  expected: string;
  actual: string;
}

export interface StubReplayDeps {
  executor: ExecutorLike;
  steps: ReplayStep[];
  /**
   * Capture an initial screenshot before step 0 so the first step's
   * `beforeSha256` has something to compare against. This adds one screenshot
   * action not present in the golden; leave false if the golden already opens
   * with a screenshot step.
   */
  captureInitial?: boolean;
  /**
   * End reason to report when the action list is exhausted without an in-band
   * `done` / `escalate`. Mirrors the golden's `TrajectoryTerminal.endReason`
   * (e.g. a golden that timed out). Defaults to "done".
   */
  fallbackEndReason?: EndReason;
}

export interface ReplayOutcome {
  endReason: EndReason;
  /** set when a `done` action was replayed. */
  summary?: string;
  /** set when an `escalate` action was replayed. */
  reason?: string;
  /** executor actions performed. */
  steps: number;
  /** the CUAction sequence actually executed, in order. */
  actions: CUAction[];
  /** recorded (non-fatal) screenshot-hash drift. */
  drift: DriftRecord[];
}

export async function replayTrajectory(deps: StubReplayDeps): Promise<ReplayOutcome> {
  const actions: CUAction[] = [];
  const drift: DriftRecord[] = [];
  let steps = 0;
  let currentHash: string | null = null;

  if (deps.captureInitial) {
    const init = await deps.executor.execute({ kind: 'screenshot' });
    actions.push({ kind: 'screenshot' });
    steps += 1;
    currentHash = init.obs.screenshotSha256;
  }

  for (const step of deps.steps) {
    // Drift is compared against the observation held BEFORE the action, so it
    // is recorded even for terminal actions.
    if (
      currentHash !== null &&
      step.beforeSha256 !== undefined &&
      currentHash !== step.beforeSha256
    ) {
      drift.push({ stepIndex: steps, expected: step.beforeSha256, actual: currentHash });
    }

    if (step.action.kind === 'done') {
      actions.push(step.action);
      return { endReason: 'done', summary: step.action.summary, steps, actions, drift };
    }
    if (step.action.kind === 'escalate') {
      actions.push(step.action);
      return { endReason: 'escalate', reason: step.action.reason, steps, actions, drift };
    }

    const exec = await deps.executor.execute(step.action);
    actions.push(step.action);
    steps += 1;

    if (exec.result.blocked?.rule === 'action_budget_exhausted') {
      return { endReason: 'budget_exhausted', steps, actions, drift };
    }
    currentHash = exec.obs.screenshotSha256;
  }

  return { endReason: deps.fallbackEndReason ?? 'done', steps, actions, drift };
}
