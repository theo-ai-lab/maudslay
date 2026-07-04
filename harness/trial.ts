/**
 * One trial: restore the sim to the task's seed, run a policy through the real
 * executor, read the two independent witnesses (confirmation email + backend
 * state), and hand them to the verifier for a screen-free verdict.
 *
 * "Restore between trials" is the reset at the top of every trial: the admin
 * plane drops and reloads the DB and clears the mailbox, so each trial starts
 * from an identical, known state. The verifier is never given a screenshot —
 * only the email witness (from the SMTP sink's mailbox) and the DB witness
 * (admin GET /state). That separation is the whole point of the project.
 *
 * A policy is anything that drives the executor: `makeStubPolicy` replays a
 * golden (deterministic CI plumbing), `makeLivePolicy` runs the model loop.
 */

import { readFileSync } from "node:fs";
import type {
  TaskSpec,
  TaskExpectation,
  TrialResult,
  TrajectoryHeader,
  CapturedEmail,
  ModelConfig,
  TrajectoryLine,
} from "../src/types.ts";
import { PORTS, VAR_DIRS } from "../src/types.ts";
import { launchBrowser } from "../executor/browser.ts";
import type { BrowserSession } from "../executor/browser.ts";
import { createBrowserExecutor } from "../executor/tools.ts";
import { Recorder } from "../executor/recorder.ts";
import {
  Sandbox,
  defaultSandboxConfig,
  autoApproveCallback,
} from "../executor/sandbox.ts";
import type { ApprovalCallback } from "../executor/sandbox.ts";
import { listMail } from "../groundtruth/email-store.ts";
import { verify, normalizeSnapshot } from "../groundtruth/verifier.ts";
import type { DbStateSnapshot, AgentEndReason } from "../groundtruth/verifier.ts";
import { createState, startServer } from "../sim/server.ts";
import { startAdmin } from "../sim/admin.ts";
import { applySeed, computeAnchor } from "../sim/seed.ts";
import { createSmtpSink } from "../groundtruth/smtp-sink.ts";
import type { ExecutorLike, EndReason } from "../agent/loop.ts";
import { runLoop } from "../agent/loop.ts";
import { replayTrajectory } from "../agent/stub-policy.ts";
import type { ReplayStep } from "../agent/stub-policy.ts";
import { AnthropicModel } from "../agent/model.ts";
import type { AnthropicModelOptions } from "../agent/model.ts";

export const HARNESS_VERSION = "0.1.0";
export const SIM_VERSION = "0.1.0";

/** A Playwright Page as surfaced by the executor — used without importing playwright. */
export type HarnessPage = BrowserSession["page"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Policy surface
// ---------------------------------------------------------------------------

export interface PolicyContext {
  executor: ExecutorLike;
  page: HarnessPage;
  publicBase: string;
  task: TaskSpec;
}

export interface PolicyOutcome {
  endReason: AgentEndReason;
  steps: number;
  summary?: string;
  reason?: string;
  error?: string;
}

export interface TrialPolicy {
  readonly label: string;
  run(ctx: PolicyContext): Promise<PolicyOutcome>;
}

function toPolicyOutcome(
  endReason: AgentEndReason,
  steps: number,
  extra: { summary?: string | undefined; reason?: string | undefined; error?: string | undefined },
): PolicyOutcome {
  const out: PolicyOutcome = { endReason, steps };
  if (extra.summary !== undefined) out.summary = extra.summary;
  if (extra.reason !== undefined) out.reason = extra.reason;
  if (extra.error !== undefined) out.error = extra.error;
  return out;
}

// ---------------------------------------------------------------------------
// Golden replay policy (stub) — deterministic CI plumbing
// ---------------------------------------------------------------------------

export function loadGoldenReplaySteps(path: string): ReplayStep[] {
  const text = readFileSync(path, "utf8");
  const steps: ReplayStep[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parsed = JSON.parse(line) as TrajectoryLine;
    if (parsed.t === "step") {
      const step: ReplayStep = { action: parsed.v.action };
      const sha = parsed.v.obs.screenshotSha256;
      if (sha) step.beforeSha256 = sha;
      steps.push(step);
    }
  }
  return steps;
}

export function loadGoldenTerminalReason(path: string): EndReason | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as TrajectoryLine;
      if (parsed.t === "terminal") return parsed.v.endReason;
    } catch {
      // skip malformed lines
    }
  }
  return undefined;
}

export function makeStubPolicy(goldenPath: string): TrialPolicy {
  const steps = loadGoldenReplaySteps(goldenPath);
  const fallback = loadGoldenTerminalReason(goldenPath) ?? "done";
  return {
    label: "stub",
    async run(ctx) {
      const outcome = await replayTrajectory({
        executor: ctx.executor,
        steps,
        captureInitial: true,
        fallbackEndReason: fallback,
      });
      return toPolicyOutcome(outcome.endReason, outcome.steps, {
        summary: outcome.summary,
        reason: outcome.reason,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Live model policy — the real observe→act loop (key-gated)
// ---------------------------------------------------------------------------

export function makeLivePolicy(
  config: ModelConfig,
  opts: { apiKey?: string; system?: string } = {},
): TrialPolicy {
  return {
    label: config.model,
    async run(ctx) {
      const modelOpts: AnthropicModelOptions = {};
      if (opts.apiKey !== undefined) modelOpts.apiKey = opts.apiKey;
      if (opts.system !== undefined) modelOpts.system = opts.system;
      const model = new AnthropicModel(config, modelOpts);
      const outcome = await runLoop({
        model,
        executor: ctx.executor,
        instruction: ctx.task.instruction,
      });
      return toPolicyOutcome(outcome.endReason, outcome.steps, {
        summary: outcome.summary,
        reason: outcome.reason,
        error: outcome.error,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Reset (restore) + witness collection
// ---------------------------------------------------------------------------

export interface ResetInfo {
  resetAt: string;
  anchor: string;
}

export async function resetSim(adminBase: string, seed: string): Promise<ResetInfo> {
  const res = await fetch(`${adminBase}/reset?seed=${encodeURIComponent(seed)}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`admin reset failed (${res.status}) for seed ${seed}`);
  const body = (await res.json()) as { anchorDate?: string };
  const anchor = typeof body.anchorDate === "string" ? body.anchorDate : computeAnchor();
  const nowIso = new Date().toISOString();
  // Seeded bookings carry `${anchor}T08:00:00.000Z`. Keep resetAt strictly after
  // that so a pre-existing row is never dated as a post-reset mutation (only the
  // must_escalate path uses this dating; the mailbox, cleared on reset, is the
  // primary mutation signal regardless).
  const seededCutoff = `${anchor}T08:00:00.500Z`;
  const resetAt = nowIso > seededCutoff ? nowIso : seededCutoff;
  return { resetAt, anchor };
}

async function fetchState(adminBase: string): Promise<DbStateSnapshot> {
  const res = await fetch(`${adminBase}/state`);
  if (!res.ok) throw new Error(`admin /state failed (${res.status})`);
  return normalizeSnapshot(await res.json());
}

/**
 * Read both witnesses after a run, with a bounded settle so the toast-race seed
 * (durable commit lags the on-screen toast) is not mis-verified. For a
 * mutation-expecting task we wait until the confirmation email lands (or time
 * out); for a must_escalate task we wait a short fixed window so any erroneous
 * commit has a chance to appear before we assert none did.
 */
export async function collectWitnesses(
  adminBase: string,
  mailDir: string,
  expectation: TaskExpectation,
  settleMaxMs = 2000,
): Promise<{ emails: CapturedEmail[]; db: DbStateSnapshot }> {
  const mutationExpected = expectation.kind !== "must_escalate";
  const start = Date.now();
  for (;;) {
    const emails = listMail(mailDir);
    const db = await fetchState(adminBase);
    const elapsed = Date.now() - start;
    if (mutationExpected) {
      if (emails.length > 0 || elapsed >= settleMaxMs) return { emails, db };
    } else if (elapsed >= Math.min(700, settleMaxMs)) {
      return { emails, db };
    }
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------
// One trial
// ---------------------------------------------------------------------------

export interface RunTrialDeps {
  task: TaskSpec;
  trialIndex: number;
  /** label recorded as the trajectory/report model id ("stub", "oracle", model id). */
  modelLabel: string;
  policy: TrialPolicy;
  session: BrowserSession;
  adminBase: string;
  publicBase: string;
  mailDir: string;
  /** exact JSONL path this trial writes its trajectory to. */
  trajectoryPath: string;
  approval?: ApprovalCallback;
  settleMaxMs?: number;
}

export async function runTrial(deps: RunTrialDeps): Promise<TrialResult> {
  const { task } = deps;
  const { resetAt } = await resetSim(deps.adminBase, task.seed);
  await deps.session.page.goto(`${deps.publicBase}/`);

  const recorder = new Recorder(deps.trajectoryPath);
  const header: TrajectoryHeader = {
    taskId: task.id,
    seed: task.seed,
    model: deps.modelLabel,
    startedAt: new Date().toISOString(),
    simVersion: SIM_VERSION,
    harnessVersion: HARNESS_VERSION,
  };
  recorder.header(header);

  const sandbox = new Sandbox(
    defaultSandboxConfig({ actionBudget: task.actionBudget }),
    deps.approval ?? autoApproveCallback,
  );
  const executor = createBrowserExecutor(deps.session.page, sandbox, task.id, recorder);

  const startedAt = Date.now();
  const ctx: PolicyContext = {
    executor,
    page: deps.session.page,
    publicBase: deps.publicBase,
    task,
  };
  const outcome = await deps.policy.run(ctx);
  const { emails, db } = await collectWitnesses(
    deps.adminBase,
    deps.mailDir,
    task.expectation,
    deps.settleMaxMs,
  );
  const verdict = verify({
    expectation: task.expectation,
    endReason: outcome.endReason,
    emails,
    db,
    resetAt,
  });
  const durationMs = Date.now() - startedAt;

  recorder.terminal({
    endedAt: new Date().toISOString(),
    endReason: outcome.endReason,
    verdict,
  });

  return {
    taskId: task.id,
    trialIndex: deps.trialIndex,
    model: deps.modelLabel,
    verdict,
    steps: outcome.steps,
    durationMs,
    trajectoryPath: deps.trajectoryPath,
  };
}

// ---------------------------------------------------------------------------
// Harness environment bootstrap (sim public + admin, SMTP sink, browser)
// ---------------------------------------------------------------------------

export interface HarnessEnv {
  publicBase: string;
  adminBase: string;
  mailDir: string;
  anchor: string;
  session: BrowserSession;
  stop(): Promise<void>;
}

export interface StartEnvOptions {
  headless?: boolean;
  dbPath?: string;
  anchor?: string;
}

export async function startHarnessEnv(opts: StartEnvOptions = {}): Promise<HarnessEnv> {
  const anchor = opts.anchor ?? computeAnchor();
  const dbPath = opts.dbPath ?? VAR_DIRS.db;
  const state = createState(dbPath, anchor);
  applySeed(state, "default");
  const pub = await startServer(state, PORTS.sim);
  const adm = await startAdmin(state, PORTS.simAdmin);
  const sink = createSmtpSink({ mailDir: VAR_DIRS.mail });
  await sink.start();
  const session = await launchBrowser({ headless: opts.headless ?? true });

  const stop = async (): Promise<void> => {
    await session.close();
    await sink.stop();
    await new Promise<void>((r) => pub.close(() => r()));
    await new Promise<void>((r) => adm.close(() => r()));
  };

  return {
    publicBase: `http://127.0.0.1:${PORTS.sim}`,
    adminBase: `http://127.0.0.1:${PORTS.simAdmin}`,
    mailDir: sink.mailDir,
    anchor,
    session,
    stop,
  };
}
