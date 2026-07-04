/**
 * Sandbox — the enforcement layer between an agent's proposed action and the
 * real browser. It never trusts the agent: it independently re-checks origin,
 * viewport bounds, a per-trial action budget, and — the point of the whole
 * project — intercepts clicks on irreversible commit controls so an approval
 * decision, not the model's confidence, guards the one-way door.
 *
 * The DOM read that classifies a click (data-guard) happens in the executor
 * (tools.ts) because only that layer holds the Playwright page; this module
 * takes the already-read guard value and decides disposition. That keeps every
 * decision here pure and unit-testable without a browser.
 */

import { randomUUID } from 'node:crypto';
import { PORTS } from '../src/types.ts';
import type { SandboxBlock, ApprovalRequest, ApprovalDecision } from '../src/types.ts';

/** How the sandbox treats a click whose nearest [data-guard] holds a value. */
export type GuardDisposition = 'require_approval' | 'allow';

/** Supplied by the approval layer (T4 approval.ts wires the real policy). */
export type ApprovalCallback = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export interface SandboxConfig {
  /** exact origin the agent may interact with, e.g. "http://127.0.0.1:4380". */
  allowedOrigin: string;
  viewport: { width: number; height: number };
  /** max actions per trial; each execute() attempt consumes one unit. */
  actionBudget: number;
  /**
   * data-guard attribute value -> disposition. Unlisted values default to
   * "allow". Config-driven so a live deployment can classify differently
   * (e.g. treat additional markers as irreversible) without code changes.
   */
  guardRules: Record<string, GuardDisposition>;
  /** if the DOM guard read throws, treat the click as requiring approval. */
  failClosedOnGuardError: boolean;
}

export function defaultSandboxConfig(
  overrides: Partial<SandboxConfig> = {},
): SandboxConfig {
  return {
    allowedOrigin: `http://127.0.0.1:${PORTS.sim}`,
    viewport: { width: 1280, height: 800 },
    actionBudget: 40,
    guardRules: { irreversible: 'require_approval' },
    failClosedOnGuardError: true,
    ...overrides,
  };
}

/** Approves everything and records the decision — CI/stub convenience only. */
export const autoApproveCallback: ApprovalCallback = async (req) => ({
  id: req.id,
  decision: 'approve',
  decidedBy: 'sandbox:auto',
  decidedAt: new Date().toISOString(),
});

/** Denies everything — the safe default when no policy is wired. */
export const denyAllCallback: ApprovalCallback = async (req) => ({
  id: req.id,
  decision: 'deny',
  reason: 'no approval policy wired',
  decidedBy: 'sandbox:auto',
  decidedAt: new Date().toISOString(),
});

export class Sandbox {
  readonly config: SandboxConfig;
  /** every approval decision the sandbox obtained, in order (for evidence). */
  readonly approvals: ApprovalDecision[] = [];
  private readonly approve: ApprovalCallback;
  private actionsUsed = 0;

  constructor(config: SandboxConfig, approve: ApprovalCallback) {
    this.config = config;
    this.approve = approve;
  }

  budgetUsed(): number {
    return this.actionsUsed;
  }

  budgetRemaining(): number {
    return Math.max(0, this.config.actionBudget - this.actionsUsed);
  }

  budgetExhausted(): boolean {
    return this.actionsUsed >= this.config.actionBudget;
  }

  /** Call once per attempted action. Returns a block if the budget is spent. */
  consumeBudget(): SandboxBlock | null {
    if (this.budgetExhausted()) {
      return {
        rule: 'action_budget_exhausted',
        detail: `action budget of ${this.config.actionBudget} exhausted`,
      };
    }
    this.actionsUsed += 1;
    return null;
  }

  checkOrigin(currentUrl: string): SandboxBlock | null {
    let origin: string;
    try {
      origin = new URL(currentUrl).origin;
    } catch {
      return { rule: 'origin_denied', detail: `unparseable url: ${currentUrl}` };
    }
    if (origin !== this.config.allowedOrigin) {
      return {
        rule: 'origin_denied',
        detail: `origin ${origin} not in allowlist (${this.config.allowedOrigin})`,
      };
    }
    return null;
  }

  checkBounds(x: number, y: number): SandboxBlock | null {
    const { width, height } = this.config.viewport;
    const inX = Number.isFinite(x) && x >= 0 && x < width;
    const inY = Number.isFinite(y) && y >= 0 && y < height;
    if (!inX || !inY) {
      return {
        rule: 'viewport_bounds',
        detail: `(${x},${y}) outside 0..${width - 1} x 0..${height - 1}`,
      };
    }
    return null;
  }

  classifyGuard(guardValue: string | null): GuardDisposition {
    if (guardValue === null) return 'allow';
    return this.config.guardRules[guardValue] ?? 'allow';
  }

  /**
   * Resolve a click's guard. "allow" -> null (proceed). "require_approval" ->
   * ask the approval callback and only proceed on approve; on deny return an
   * approval_required block carrying the request id. forceApproval overrides
   * classification (used when the DOM guard read failed and the config is
   * fail-closed).
   */
  async resolveGuard(
    guardValue: string | null,
    taskId: string,
    actionSummary: string,
    forceApproval = false,
  ): Promise<SandboxBlock | null> {
    const disposition = forceApproval ? 'require_approval' : this.classifyGuard(guardValue);
    if (disposition === 'allow') return null;

    const req: ApprovalRequest = {
      id: randomUUID(),
      actionSummary,
      requestedAt: new Date().toISOString(),
      taskId,
    };
    const decision = await this.approve(req);
    this.approvals.push(decision);
    if (decision.decision === 'approve') return null;
    return {
      rule: 'approval_required',
      detail: `approval denied: ${decision.reason}`,
      approvalId: req.id,
    };
  }
}
