/**
 * Executor — the ONE surface the agent under test touches. It takes a proposed
 * CUAction, runs it past the sandbox, and (if allowed) performs it against the
 * real page, then returns a fresh Observation. The agent only ever sees pixels
 * out and emits actions in; every safety decision lives in the sandbox, not in
 * the model.
 *
 * The page is injected behind a minimal ExecutorPage interface so the whole
 * action path is unit-testable with a fake — Playwright's Page satisfies it.
 */

import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type {
  CUAction,
  ActionResult,
  Observation,
  SandboxBlock,
  TrajectoryStep,
} from '../src/types.ts';
import { Sandbox } from './sandbox.ts';
import { Recorder } from './recorder.ts';

/** The slice of a browser page the executor drives. Playwright's Page fits. */
export interface ExecutorPage {
  url(): string;
  mouse: {
    click(x: number, y: number): Promise<void>;
    dblclick(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
  };
  screenshot(): Promise<Uint8Array>;
}

/** Reads the nearest [data-guard] value at a viewport coordinate, or null. */
export type GuardReader = (x: number, y: number) => Promise<string | null>;

/** Reads the nearest [data-guard] value of the currently focused element. */
export type FocusedGuardReader = () => Promise<string | null>;

export interface ExecutorDeps {
  page: ExecutorPage;
  sandbox: Sandbox;
  readGuardAt: GuardReader;
  /**
   * Reads the guard of the focused element — used to gate commit-capable
   * keyboard input (Enter/Space on a focused Confirm button), which would
   * otherwise bypass the click guard entirely. Optional so the abstract
   * Executor stays testable; when absent, commit keys are treated as a guard
   * read failure and fall back to the sandbox's fail-closed policy.
   */
  readGuardOfFocused?: FocusedGuardReader;
  taskId: string;
  recorder?: Recorder;
}

/**
 * Keys that can activate a focused control (submit a form / press a button)
 * without a pointer event — the keyboard route around the click guard.
 */
function isCommitKey(combo: string): boolean {
  const parts = combo.split('+');
  const raw = parts[parts.length - 1] ?? '';
  const last = raw.trim().toLowerCase();
  return (
    last === 'enter' ||
    last === 'return' ||
    last === 'numpadenter' ||
    raw === ' ' || // a literal space key trims to '' — check the raw segment
    last === 'space' ||
    last === 'spacebar'
  );
}

function isInteracting(action: CUAction): boolean {
  switch (action.kind) {
    case 'click':
    case 'double_click':
    case 'type':
    case 'key':
    case 'scroll':
      return true;
    default:
      return false;
  }
}

function actionSummary(action: CUAction): string {
  switch (action.kind) {
    case 'click':
      return `click at (${action.x},${action.y})`;
    case 'double_click':
      return `double_click at (${action.x},${action.y})`;
    case 'type':
      return `type ${JSON.stringify(action.text)}`;
    case 'key':
      return `key ${action.combo}`;
    case 'scroll':
      return `scroll (${action.dx},${action.dy})`;
    case 'wait':
      return `wait ${action.ms}ms`;
    case 'screenshot':
      return 'screenshot';
    case 'escalate':
      return `escalate: ${action.reason}`;
    case 'done':
      return `done: ${action.summary}`;
  }
}

export class Executor {
  private readonly page: ExecutorPage;
  private readonly sandbox: Sandbox;
  private readonly readGuardAt: GuardReader;
  private readonly readGuardOfFocused: FocusedGuardReader | null;
  private readonly taskId: string;
  private readonly recorder: Recorder | null;
  private stepIndex = 0;
  /** last returned observation, reused as the "before" obs of the next step. */
  private lastObs: Observation | null = null;

  constructor(deps: ExecutorDeps) {
    this.page = deps.page;
    this.sandbox = deps.sandbox;
    this.readGuardAt = deps.readGuardAt;
    this.readGuardOfFocused = deps.readGuardOfFocused ?? null;
    this.taskId = deps.taskId;
    this.recorder = deps.recorder ?? null;
  }

  private async snapshot(): Promise<Observation> {
    const bytes = await this.page.screenshot();
    const buf = Buffer.from(bytes);
    return {
      screenshotB64: buf.toString('base64'),
      screenshotSha256: createHash('sha256').update(buf).digest('hex'),
      url: this.page.url(),
      stepIndex: this.stepIndex,
    };
  }

  private record(action: CUAction, result: ActionResult, beforeObs: Observation): void {
    if (this.recorder === null) return;
    const step: TrajectoryStep = {
      i: this.stepIndex,
      obs: { screenshotSha256: beforeObs.screenshotSha256, url: beforeObs.url },
      action,
      result,
      ts: new Date().toISOString(),
    };
    this.recorder.step(step);
  }

  private async finish(
    action: CUAction,
    result: ActionResult,
    beforeObs: Observation,
  ): Promise<{ result: ActionResult; obs: Observation }> {
    const obs = await this.snapshot();
    this.lastObs = obs;
    this.record(action, result, beforeObs);
    return { result, obs };
  }

  private async perform(action: CUAction): Promise<void> {
    switch (action.kind) {
      case 'click':
        await this.page.mouse.click(action.x, action.y);
        return;
      case 'double_click':
        await this.page.mouse.dblclick(action.x, action.y);
        return;
      case 'type':
        await this.page.keyboard.type(action.text);
        return;
      case 'key':
        await this.page.keyboard.press(action.combo);
        return;
      case 'scroll':
        await this.page.mouse.wheel(action.dx, action.dy);
        return;
      case 'wait':
        await new Promise((resolve) => setTimeout(resolve, action.ms));
        return;
      default:
        // screenshot: the returned observation IS the effect. escalate/done
        // never reach here (handled in execute).
        return;
    }
  }

  async execute(action: CUAction): Promise<{ result: ActionResult; obs: Observation }> {
    this.stepIndex += 1;
    const beforeObs = this.lastObs ?? (await this.snapshot());

    // Terminal actions end the trial and never touch the page — no budget,
    // origin, bounds, or guard gating applies to them.
    if (action.kind === 'escalate' || action.kind === 'done') {
      return this.finish(action, { ok: true }, beforeObs);
    }

    const budgetBlock = this.sandbox.consumeBudget();
    if (budgetBlock) return this.finish(action, { ok: false, blocked: budgetBlock }, beforeObs);

    if (isInteracting(action)) {
      const originBlock = this.sandbox.checkOrigin(this.page.url());
      if (originBlock) return this.finish(action, { ok: false, blocked: originBlock }, beforeObs);
    }

    if (action.kind === 'click' || action.kind === 'double_click') {
      const boundsBlock = this.sandbox.checkBounds(action.x, action.y);
      if (boundsBlock) return this.finish(action, { ok: false, blocked: boundsBlock }, beforeObs);

      const guardBlock = await this.resolveClickGuard(action.x, action.y, actionSummary(action));
      if (guardBlock) return this.finish(action, { ok: false, blocked: guardBlock }, beforeObs);
    }

    // Commit-capable keyboard input can activate a focused irreversible control
    // without a pointer event, bypassing the click guard. Gate it the same way:
    // an Enter/Space on a focused [data-guard=irreversible] element, or a `type`
    // carrying a newline (which submits many forms), routes through approval.
    const keyCommits = action.kind === 'key' && isCommitKey(action.combo);
    const typeCommits = action.kind === 'type' && /[\r\n]/.test(action.text);
    if (keyCommits || typeCommits) {
      const guardBlock = await this.resolveFocusedGuard(actionSummary(action));
      if (guardBlock) return this.finish(action, { ok: false, blocked: guardBlock }, beforeObs);
    }

    try {
      await this.perform(action);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.finish(action, { ok: false, error: message }, beforeObs);
    }

    return this.finish(action, { ok: true }, beforeObs);
  }

  private async resolveClickGuard(
    x: number,
    y: number,
    summary: string,
  ): Promise<SandboxBlock | null> {
    let guardValue: string | null = null;
    let readFailed = false;
    try {
      guardValue = await this.readGuardAt(x, y);
    } catch {
      readFailed = true;
    }
    const forceApproval = readFailed && this.sandbox.config.failClosedOnGuardError;
    const detailSummary = readFailed ? `${summary} (guard read failed)` : summary;
    return this.sandbox.resolveGuard(guardValue, this.taskId, detailSummary, forceApproval);
  }

  private async resolveFocusedGuard(summary: string): Promise<SandboxBlock | null> {
    let guardValue: string | null = null;
    let readFailed = false;
    if (this.readGuardOfFocused === null) {
      // No focus reader wired: we cannot see what the key would activate, so
      // treat it as an unreadable guard and defer to the fail-closed policy.
      readFailed = true;
    } else {
      try {
        guardValue = await this.readGuardOfFocused();
      } catch {
        readFailed = true;
      }
    }
    const forceApproval = readFailed && this.sandbox.config.failClosedOnGuardError;
    const detailSummary = readFailed ? `${summary} (focused-guard read failed)` : summary;
    return this.sandbox.resolveGuard(guardValue, this.taskId, detailSummary, forceApproval);
  }
}

/**
 * Wire an Executor around a live Playwright page. This is where the DOM guard
 * read actually happens: elementFromPoint at the click coordinate, then the
 * nearest [data-guard] ancestor's value.
 */
export function createBrowserExecutor(
  page: Page,
  sandbox: Sandbox,
  taskId: string,
  recorder?: Recorder,
): Executor {
  const readGuardAt: GuardReader = (x, y) =>
    page.evaluate(
      (pt) => {
        const el = document.elementFromPoint(pt.x, pt.y);
        if (!el) return null;
        const guarded = el.closest('[data-guard]');
        return guarded ? guarded.getAttribute('data-guard') : null;
      },
      { x, y },
    );

  const readGuardOfFocused: FocusedGuardReader = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const guarded = el.closest('[data-guard]');
      return guarded ? guarded.getAttribute('data-guard') : null;
    });

  const deps: ExecutorDeps = recorder
    ? { page, sandbox, readGuardAt, readGuardOfFocused, taskId, recorder }
    : { page, sandbox, readGuardAt, readGuardOfFocused, taskId };
  return new Executor(deps);
}
