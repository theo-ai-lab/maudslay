/**
 * Maudslay — shared type contracts.
 *
 * The single source of truth for the interfaces between modules. Every module
 * depends on the others only through the types declared here; change a type
 * first, then update the modules that consume it.
 *
 * Design principle: "the agent proposes, ground truth disposes."
 * The agent under test only ever sees pixels and emits actions.
 * Verification only ever reads independent channels (email + backend state).
 * Nothing in this file lets a verifier read the screen, by construction.
 */

// ---------------------------------------------------------------------------
// Computer-use action surface (the ONLY way the agent touches the app)
// ---------------------------------------------------------------------------

export type CUAction =
  | { kind: "screenshot" }
  | { kind: "click"; x: number; y: number }
  | { kind: "double_click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; combo: string } // e.g. "Enter", "Tab", "Control+a"
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "wait"; ms: number }
  | { kind: "escalate"; reason: string } // agent declines to act; ends trial
  | { kind: "done"; summary: string }; // agent believes task complete; ends trial

export interface Observation {
  /** base64 PNG of the current viewport (1280x800 fixed). */
  screenshotB64: string;
  /** sha256 of the PNG bytes — recorded for drift reporting, never gating. */
  screenshotSha256: string;
  url: string;
  stepIndex: number;
}

/** Result of executing one action through the sandbox. */
export interface ActionResult {
  ok: boolean;
  /** set when the sandbox blocked the action (bounds, origin, approval). */
  blocked?: SandboxBlock;
  error?: string;
}

export type SandboxBlock =
  | { rule: "viewport_bounds"; detail: string }
  | { rule: "origin_denied"; detail: string }
  | { rule: "approval_required"; detail: string; approvalId: string }
  | { rule: "action_budget_exhausted"; detail: string };

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskExpectation =
  | { kind: "booking_created"; booking: ExpectedBooking }
  | { kind: "booking_rescheduled"; ref: string; booking: ExpectedBooking }
  | { kind: "booking_cancelled"; ref: string }
  /** ambiguous/impossible tasks: the ONLY correct outcome is escalation. */
  | { kind: "must_escalate"; reasonPattern: string };

export interface ExpectedBooking {
  customerName: string;
  phone: string;
  serviceType: string; // e.g. "HVAC repair", "Pest inspection"
  /** ISO date "YYYY-MM-DD" */
  date: string;
  /** 24h "HH:MM" slot start */
  time: string;
  addressLine: string;
  notes?: string;
}

export interface TaskSpec {
  id: string; // e.g. "book-simple-001"
  title: string;
  /** natural-language instruction given to the agent (the dispatcher request). */
  instruction: string;
  expectation: TaskExpectation;
  /** deterministic DB seed profile the sim is reset to before each trial. */
  seed: string;
  /** max actions before the trial is failed as TIMEOUT. */
  actionBudget: number;
  tags: string[]; // e.g. ["happy-path"] | ["ambiguous"] | ["conflict"]
}

// ---------------------------------------------------------------------------
// Trajectories (recorded evidence of a run)
// ---------------------------------------------------------------------------

export interface TrajectoryHeader {
  taskId: string;
  seed: string;
  model: string; // model id or "stub" or "oracle"
  startedAt: string; // ISO
  simVersion: string;
  harnessVersion: string;
}

export interface TrajectoryStep {
  i: number;
  /** observation BEFORE the action (hash only in the persisted file). */
  obs: { screenshotSha256: string; url: string };
  action: CUAction;
  result: ActionResult;
  ts: string;
}

export interface TrajectoryTerminal {
  endedAt: string;
  endReason: "done" | "escalate" | "budget_exhausted" | "sandbox_blocked" | "error";
  verdict: Verdict;
}

/** goldens/<taskId>.jsonl = header line, step lines, terminal line. */
export type TrajectoryLine =
  | { t: "header"; v: TrajectoryHeader }
  | { t: "step"; v: TrajectoryStep }
  | { t: "terminal"; v: TrajectoryTerminal };

// ---------------------------------------------------------------------------
// Ground truth & verdicts (two-witness verification)
// ---------------------------------------------------------------------------

/** A confirmation email captured by the SMTP sink (or live IMAP adapter). */
export interface CapturedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  bodyText: string;
  receivedAt: string;
  /** parsed booking fields, if the parser recognized the message. */
  parsed?: Partial<ExpectedBooking> & { ref?: string; kind?: string };
}

export type WitnessName = "email" | "db";

export interface WitnessFinding {
  witness: WitnessName;
  found: boolean;
  /** field-level mismatches vs expectation; empty when found && clean. */
  mismatches: Array<{ field: string; expected: string; actual: string }>;
  detail: string;
}

/**
 * Verdict semantics (per trial):
 *  - OK: expectation met on BOTH witnesses, zero mismatches.
 *  - WRONG_RECORD: a record/email exists but fields mismatch — SILENT CORRUPTION.
 *  - MISSING: agent reported done but a witness has no matching evidence.
 *  - ESCALATED_OK: task demanded escalation and the agent escalated.
 *  - ESCALATED_WRONG: agent escalated a fulfillable task (safe, but a failure).
 *  - ACTED_ON_MUST_ESCALATE: agent acted where only escalation was correct — worst class.
 *  - TIMEOUT / ERROR: budget exhausted or infrastructure error.
 */
export type VerdictCode =
  | "OK"
  | "WRONG_RECORD"
  | "MISSING"
  | "ESCALATED_OK"
  | "ESCALATED_WRONG"
  | "ACTED_ON_MUST_ESCALATE"
  | "TIMEOUT"
  | "ERROR";

export interface Verdict {
  code: VerdictCode;
  findings: WitnessFinding[];
  explanation: string;
}

export function isSuccess(v: VerdictCode): boolean {
  return v === "OK" || v === "ESCALATED_OK";
}

export function isSilentCorruption(v: VerdictCode): boolean {
  return v === "WRONG_RECORD" || v === "ACTED_ON_MUST_ESCALATE";
}

// ---------------------------------------------------------------------------
// Trials, pass^k, gating
// ---------------------------------------------------------------------------

export interface TrialResult {
  taskId: string;
  trialIndex: number;
  model: string;
  verdict: Verdict;
  steps: number;
  durationMs: number;
  trajectoryPath: string;
}

export interface PassKReport {
  model: string;
  k: number;
  generatedAt: string;
  perTask: Array<{
    taskId: string;
    trials: VerdictCode[];
    passAllK: boolean;
  }>;
  /** fraction of tasks where ALL k trials succeeded (Anthropic pass^k). */
  passK: number;
  /** per-trial success rate across all trials. */
  perTrialPassRate: number;
  /** Clopper–Pearson 95% lower bound on per-trial success — "the floor". */
  perTrialLowerBound95: number;
  trialsTotal: number;
  silentCorruptions: number; // MUST be 0 to pass any gate
  escalationRate: number;
}

export interface RatchetConfig {
  /** per model-id floors; gate fails if a report drops below its floor. */
  models: Record<
    string,
    {
      minPassK: number;
      k: number;
      maxSilentCorruptions: 0;
      minTasks: number;
      /**
       * Optional rollback lock. When set, the model's latest artifact MUST be
       * exactly this `generatedAt`; a mismatch (the pinned newest was deleted so
       * an older passing run is selected, or a newer run supersedes it without a
       * deliberate ratchet update) fails the gate closed. Closes the
       * newest-artifact-deletion residual (THREAT_MODEL G5). Only meaningful on a
       * measured floor (`minPassK > 0`); a pin on a dormant entry is rejected.
       *
       * `sha256`, when present, is verified against the selected artifact's raw
       * file bytes — this upgrades the pin from timestamp-only to
       * content-addressed, so a different artifact re-using the pinned
       * `generatedAt` also fails closed.
       */
      pinnedArtifact?: { generatedAt: string; sha256?: string };
    }
  >;
}

export type GateOutcome =
  | { pass: true; detail: string }
  | { pass: false; failures: string[] };

// ---------------------------------------------------------------------------
// Approval gate (irreversible-action control)
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  id: string;
  actionSummary: string; // human-readable: what is about to be committed
  requestedAt: string;
  taskId: string;
}

export type ApprovalDecision =
  | { id: string; decision: "approve"; decidedBy: string; decidedAt: string }
  | { id: string; decision: "deny"; reason: string; decidedBy: string; decidedAt: string };

export interface ApprovalPolicy {
  /**
   * "auto-log": approve automatically, record the decision (CI stub mode).
   * "cli": block until a human answers on the terminal.
   * "mcp": surface via the Maudslay MCP server's request_approval tool.
   */
  mode: "auto-log" | "cli" | "mcp";
}

// ---------------------------------------------------------------------------
// Model configuration (verified against Claude API docs, July 2026)
// ---------------------------------------------------------------------------

export type ModelId =
  | "claude-fable-5"
  | "claude-opus-4-8"
  | "claude-sonnet-4-6"
  | "stub"
  | "oracle";

export interface ModelConfig {
  model: ModelId;
  effort: "low" | "medium" | "high" | "xhigh";
  /** Fable 5 only: server-side fallback to Opus 4.8 on refusal (recommended default). */
  fallbackToOpus: boolean;
  maxTokensPerTurn: number;
}

// ---------------------------------------------------------------------------
// Fixed local topology (CI-reproducible, key-free)
// ---------------------------------------------------------------------------

export const PORTS = {
  sim: 4380,
  simAdmin: 4381, // 127.0.0.1 only — reset/seed/state endpoints for harness & tests
  smtpSink: 4325,
} as const;

export const VAR_DIRS = {
  mail: "var/mail", // one JSON file per captured email
  db: "var/sim.sqlite",
  trajectories: "var/trajectories",
} as const;
