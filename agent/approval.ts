/**
 * Approval policies for irreversible-action control. The sandbox intercepts a
 * click on a guarded (irreversible) control and asks an approval callback for a
 * decision; this module provides that callback for each policy mode and keeps an
 * ordered log of every request/decision pair as evidence.
 *
 *  - "auto-log": approve automatically and record it (CI / stub mode).
 *  - "cli": block on the terminal until an operator answers.
 *  - "mcp": defer to a provided delegate (e.g. the Maudslay MCP server's
 *    request_approval tool).
 */

import { createInterface } from 'node:readline/promises';
import type {
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalDecision,
} from '../src/types.ts';

/** Same shape the sandbox expects for its approval callback. */
export type ApprovalCallback = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export interface ApprovalLogEntry {
  request: ApprovalRequest;
  decision: ApprovalDecision;
}

export interface ApprovalHandler {
  readonly policy: ApprovalPolicy;
  readonly log: ApprovalLogEntry[];
  /** Decide a single request (also records it in `log`). */
  decide(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** A bound callback suitable for `new Sandbox(config, handler.callback())`. */
  callback(): ApprovalCallback;
}

export interface ApprovalOptions {
  /** Identity recorded in `decidedBy` (defaults per mode). */
  actor?: string;
  /**
   * cli mode: override the terminal prompt. Receives the question, returns the
   * operator's raw answer. Defaults to a readline prompt over stdin/stdout.
   */
  prompt?: (question: string) => Promise<string>;
  /** mcp mode: the delegate that surfaces the request and returns a decision. */
  delegate?: ApprovalCallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function approve(req: ApprovalRequest, by: string): ApprovalDecision {
  return { id: req.id, decision: 'approve', decidedBy: by, decidedAt: nowIso() };
}

function deny(req: ApprovalRequest, by: string, reason: string): ApprovalDecision {
  return { id: req.id, decision: 'deny', reason, decidedBy: by, decidedAt: nowIso() };
}

async function terminalPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function affirmative(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

class BaseApproval implements ApprovalHandler {
  readonly policy: ApprovalPolicy;
  readonly log: ApprovalLogEntry[] = [];
  protected readonly actor: string;

  constructor(mode: ApprovalPolicy['mode'], actor: string) {
    this.policy = { mode };
    this.actor = actor;
  }

  protected record(request: ApprovalRequest, decision: ApprovalDecision): ApprovalDecision {
    this.log.push({ request, decision });
    return decision;
  }

  // Overridden by each mode.
  async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    return this.record(req, deny(req, this.actor, 'no policy'));
  }

  callback(): ApprovalCallback {
    return (req) => this.decide(req);
  }
}

class AutoLogApproval extends BaseApproval {
  override async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    return this.record(req, approve(req, this.actor));
  }
}

class CliApproval extends BaseApproval {
  private readonly ask: (question: string) => Promise<string>;

  constructor(actor: string, ask: (question: string) => Promise<string>) {
    super('cli', actor);
    this.ask = ask;
  }

  override async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    const question =
      `Approve irreversible action for task ${req.taskId}?\n` +
      `  ${req.actionSummary}\n` +
      `Type "y" to approve, anything else to deny: `;
    const answer = await this.ask(question);
    const decision = affirmative(answer)
      ? approve(req, this.actor)
      : deny(req, this.actor, 'operator declined at terminal');
    return this.record(req, decision);
  }
}

class McpApproval extends BaseApproval {
  private readonly delegate: ApprovalCallback;

  constructor(actor: string, delegate: ApprovalCallback) {
    super('mcp', actor);
    this.delegate = delegate;
  }

  override async decide(req: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = await this.delegate(req);
    return this.record(req, decision);
  }
}

/**
 * Construct an approval handler for a policy mode. `auto-log` and `cli` are
 * fully implemented; `mcp` requires a `delegate` (throws at construction if
 * absent, so the misconfiguration surfaces before any run rather than at the
 * one-way door).
 */
export function createApprovalHandler(
  policy: ApprovalPolicy,
  opts: ApprovalOptions = {},
): ApprovalHandler {
  switch (policy.mode) {
    case 'auto-log':
      return new AutoLogApproval('auto-log', opts.actor ?? 'auto-log');
    case 'cli':
      return new CliApproval(opts.actor ?? 'cli-operator', opts.prompt ?? terminalPrompt);
    case 'mcp': {
      if (!opts.delegate) {
        throw new Error('mcp approval policy requires a delegate callback');
      }
      return new McpApproval(opts.actor ?? 'mcp', opts.delegate);
    }
  }
}
