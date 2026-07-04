/**
 * Observe -> act loop. Each turn the model proposes tool calls; the loop
 * translates a `computer` call into an internal `CUAction` (per the D4 mapping),
 * runs it through the executor, and feeds the resulting screenshot back as the
 * next observation. Terminal `done` / `escalate` tool calls end the run. Every
 * safety decision is the sandbox's — the loop only routes actions and results.
 */

import type { CUAction, ActionResult, Observation } from '../src/types.ts';
import type { AgentModel, ModelTurn, ToolResultInput } from './model.ts';

// --- D4 action translation (model action JSON -> CUAction) ---

export type TranslateResult =
  | { ok: true; action: CUAction; bestEffort?: boolean }
  | { ok: false; reason: 'unsupported'; note: string }
  | { ok: false; reason: 'invalid'; note: string };

/** Pixels-per-unit used to turn a scroll direction+amount into wheel deltas. */
export const SCROLL_PX_PER_UNIT = 100;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function readCoordinate(rec: Record<string, unknown>): { x: number; y: number } | null {
  const c = rec.coordinate;
  if (!Array.isArray(c) || c.length < 2) return null;
  const x = c[0];
  const y = c[1];
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function scrollToDelta(direction: string, amount: number): { dx: number; dy: number } {
  const mag = Math.abs(amount) * SCROLL_PX_PER_UNIT;
  switch (direction) {
    case 'up':
      return { dx: 0, dy: -mag };
    case 'down':
      return { dx: 0, dy: mag };
    case 'left':
      return { dx: -mag, dy: 0 };
    default:
      return { dx: mag, dy: 0 }; // 'right'
  }
}

/**
 * Translate one `computer` tool input (`{action, coordinate?, text?, ...}`) into
 * a CUAction. Directly-mapped actions (D4 table) become their CUAction; a couple
 * of unmapped actions get a documented best-effort equivalent; the rest are
 * reported as unsupported so the loop can note them and continue.
 */
export function translateComputerAction(input: unknown): TranslateResult {
  const rec = asRecord(input);
  if (!rec) return { ok: false, reason: 'invalid', note: 'computer input is not an object' };
  const action = rec.action;
  if (typeof action !== 'string') {
    return { ok: false, reason: 'invalid', note: 'computer input has no action name' };
  }

  switch (action) {
    case 'screenshot':
      return { ok: true, action: { kind: 'screenshot' } };

    case 'left_click': {
      const c = readCoordinate(rec);
      if (!c) return { ok: false, reason: 'invalid', note: 'left_click needs coordinate [x,y]' };
      return { ok: true, action: { kind: 'click', x: c.x, y: c.y } };
    }

    case 'double_click': {
      const c = readCoordinate(rec);
      if (!c) return { ok: false, reason: 'invalid', note: 'double_click needs coordinate [x,y]' };
      return { ok: true, action: { kind: 'double_click', x: c.x, y: c.y } };
    }

    case 'type': {
      const text = rec.text;
      if (typeof text !== 'string') return { ok: false, reason: 'invalid', note: 'type needs text' };
      return { ok: true, action: { kind: 'type', text } };
    }

    case 'key': {
      const text = rec.text;
      if (typeof text !== 'string') return { ok: false, reason: 'invalid', note: 'key needs text' };
      return { ok: true, action: { kind: 'key', combo: text } };
    }

    case 'hold_key': {
      // No hold primitive in the executor surface; best-effort a single keypress
      // (the intended keystroke, without the hold duration).
      const text = rec.text;
      if (typeof text !== 'string') {
        return { ok: false, reason: 'invalid', note: 'hold_key needs text' };
      }
      return { ok: true, action: { kind: 'key', combo: text }, bestEffort: true };
    }

    case 'scroll': {
      const direction = rec.scroll_direction;
      if (
        direction !== 'up' &&
        direction !== 'down' &&
        direction !== 'left' &&
        direction !== 'right'
      ) {
        return { ok: false, reason: 'invalid', note: 'scroll needs scroll_direction up|down|left|right' };
      }
      const amount = rec.scroll_amount;
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        return { ok: false, reason: 'invalid', note: 'scroll needs numeric scroll_amount' };
      }
      const { dx, dy } = scrollToDelta(direction, amount);
      return { ok: true, action: { kind: 'scroll', dx, dy } };
    }

    case 'wait': {
      const duration = rec.duration;
      if (typeof duration !== 'number' || !Number.isFinite(duration)) {
        return { ok: false, reason: 'invalid', note: 'wait needs numeric duration (seconds)' };
      }
      return { ok: true, action: { kind: 'wait', ms: Math.round(duration * 1000) } };
    }

    // Unmapped model actions (no faithful executor equivalent): report and continue.
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
    case 'mouse_move':
    case 'left_click_drag':
    case 'left_mouse_down':
    case 'left_mouse_up':
    case 'cursor_position':
    case 'zoom':
      return { ok: false, reason: 'unsupported', note: `action '${action}' has no executor equivalent` };

    default:
      return { ok: false, reason: 'unsupported', note: `unknown action '${action}'` };
  }
}

/**
 * Dispatch a full tool call by name. `computer` routes through the D4 mapping;
 * `escalate` / `done` become their terminal CUActions.
 */
export function translateToolCall(name: string, input: unknown): TranslateResult {
  if (name === 'computer') return translateComputerAction(input);
  if (name === 'escalate') {
    const rec = asRecord(input);
    const reason = rec && typeof rec.reason === 'string' ? rec.reason : '';
    return { ok: true, action: { kind: 'escalate', reason } };
  }
  if (name === 'done') {
    const rec = asRecord(input);
    const summary = rec && typeof rec.summary === 'string' ? rec.summary : '';
    return { ok: true, action: { kind: 'done', summary } };
  }
  return { ok: false, reason: 'unsupported', note: `unknown tool '${name}'` };
}

// --- The run loop ---

export interface ExecutorLike {
  execute(action: CUAction): Promise<{ result: ActionResult; obs: Observation }>;
}

export type EndReason = 'done' | 'escalate' | 'budget_exhausted' | 'sandbox_blocked' | 'error';

export interface LoopDeps {
  model: AgentModel;
  executor: ExecutorLike;
  instruction: string;
  /**
   * Hard cap on model turns, independent of the executor's action budget — it
   * bounds runs where the model only ever emits unsupported actions (which do
   * not consume executor budget). Defaults to 64.
   */
  maxTurns?: number;
}

export interface RunOutcome {
  endReason: EndReason;
  /** set when endReason === "done". */
  summary?: string;
  /** set when endReason === "escalate". */
  reason?: string;
  /** set when endReason === "error". */
  error?: string;
  /** executor actions performed (includes the seed screenshot). */
  steps: number;
  /** model turns taken. */
  turns: number;
  /** the executed CUAction sequence, in order. */
  actions: CUAction[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeBlock(result: ActionResult): string {
  if (result.blocked) return `blocked by sandbox (${result.blocked.rule}): ${result.blocked.detail}`;
  return `action error: ${result.error ?? 'unknown'}`;
}

export async function runLoop(deps: LoopDeps): Promise<RunOutcome> {
  const maxTurns = deps.maxTurns ?? 64;
  const actions: CUAction[] = [];
  let steps = 0;
  let turns = 0;

  // Seed the transcript with the initial screen. A screenshot is a real action,
  // so it goes through the executor and is subject to the budget.
  const first = await deps.executor.execute({ kind: 'screenshot' });
  actions.push({ kind: 'screenshot' });
  steps += 1;
  if (first.result.blocked?.rule === 'action_budget_exhausted') {
    return { endReason: 'budget_exhausted', steps, turns, actions };
  }

  let turn: ModelTurn;
  try {
    turn = await deps.model.begin(deps.instruction, first.obs);
  } catch (err) {
    return { endReason: 'error', error: errMsg(err), steps, turns, actions };
  }
  turns += 1;

  for (;;) {
    if (turn.refused) {
      return {
        endReason: 'error',
        error: `model refused: ${turn.refusalDetail ?? 'safety'}`,
        steps,
        turns,
        actions,
      };
    }
    if (turn.toolCalls.length === 0) {
      return { endReason: 'error', error: 'model returned no tool call', steps, turns, actions };
    }

    const results: ToolResultInput[] = [];
    let terminal: RunOutcome | null = null;
    let budgetHit = false;

    for (const call of turn.toolCalls) {
      const t = translateToolCall(call.name, call.input);

      if (t.ok && t.action.kind === 'escalate') {
        terminal = { endReason: 'escalate', reason: t.action.reason, steps, turns, actions };
        break;
      }
      if (t.ok && t.action.kind === 'done') {
        terminal = { endReason: 'done', summary: t.action.summary, steps, turns, actions };
        break;
      }
      if (!t.ok) {
        results.push({ toolUseId: call.id, text: `action not performed: ${t.note}`, isError: true });
        continue;
      }

      const exec = await deps.executor.execute(t.action);
      actions.push(t.action);
      steps += 1;

      if (exec.result.blocked) {
        if (exec.result.blocked.rule === 'action_budget_exhausted') {
          budgetHit = true;
          break;
        }
        // Recoverable block (bounds / origin / approval): note it and let the
        // model adapt (D4).
        results.push({ toolUseId: call.id, text: describeBlock(exec.result) });
      } else if (!exec.result.ok) {
        results.push({ toolUseId: call.id, text: describeBlock(exec.result), isError: true });
      } else {
        results.push({ toolUseId: call.id, image: exec.obs.screenshotB64 });
      }
    }

    if (terminal) return terminal;
    if (budgetHit) return { endReason: 'budget_exhausted', steps, turns, actions };
    if (turns >= maxTurns) return { endReason: 'budget_exhausted', steps, turns, actions };

    try {
      turn = await deps.model.next(results);
    } catch (err) {
      return { endReason: 'error', error: errMsg(err), steps, turns, actions };
    }
    turns += 1;
  }
}
