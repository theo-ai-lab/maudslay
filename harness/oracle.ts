/**
 * The oracle: a scripted driver that KNOWS the sim and drives the real browser
 * through the executor to produce one golden trajectory per task. This is
 * BENCHMARK CONSTRUCTION, not the subject under test — it fills each form with
 * the already-known correct answer (including the resolved slot for a conflict
 * task) so the recorded trajectory verifies as a success on both witnesses.
 * `stub-policy` then replays these goldens for deterministic CI plumbing.
 *
 * The oracle locates form controls by reading their on-screen box (it is a
 * construction tool, not a verifier), then issues coordinate CUActions through
 * the executor — so every recorded step is a real, replayable action and the
 * irreversible-commit approval flow is genuinely exercised. Navigation-driving
 * clicks are followed by a recorded `wait`, which is what lets the (nav-unaware)
 * stub replay reproduce the trajectory without racing a page load.
 */

import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CUAction, ExpectedBooking, TaskSpec, VerdictCode } from "../src/types.ts";
import { isSuccess } from "../src/types.ts";
import { buildTasks } from "./tasks.ts";
import {
  startHarnessEnv,
  runTrial,
  type HarnessEnv,
  type HarnessPage,
  type PolicyContext,
  type PolicyOutcome,
  type TrialPolicy,
} from "./trial.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- DOM coordinate discovery (construction-time, not verification) ---------

async function centerOf(page: HarnessPage, selector: string): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate((sel: string): { x: number; y: number } | null => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selector);
  if (!pt) throw new Error(`oracle: element not found: ${selector}`);
  return pt;
}

async function leftOf(
  page: HarnessPage,
  selector: string,
  inset = 10,
): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate(
    (arg: { sel: string; inset: number }): { x: number; y: number } | null => {
      const el = document.querySelector(arg.sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + arg.inset), y: Math.round(r.top + r.height / 2) };
    },
    { sel: selector, inset },
  );
  if (!pt) throw new Error(`oracle: element not found: ${selector}`);
  return pt;
}

function pathEquals(url: string, path: string): boolean {
  try {
    return new URL(url).pathname === path;
  } catch {
    return false;
  }
}

async function settleNav(
  page: HarnessPage,
  pred: (url: string) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred(page.url())) {
      try {
        await page.waitForLoadState("load");
      } catch {
        // best effort; a stale state resolves on the next coordinate read
      }
      return;
    }
    if (Date.now() - start > timeoutMs) return; // proceed; drift/verify surfaces a real fault
    await sleep(50);
  }
}

// --- The scripted driver ----------------------------------------------------

class OracleDriver {
  private readonly ctx: PolicyContext;
  private readonly waitMs: number;
  private steps = 0;

  constructor(ctx: PolicyContext, waitMs: number) {
    this.ctx = ctx;
    this.waitMs = waitMs;
  }

  private async exec(action: CUAction): Promise<void> {
    await this.ctx.executor.execute(action);
    this.steps += 1;
  }

  private async click(selector: string): Promise<void> {
    const c = await centerOf(this.ctx.page, selector);
    await this.exec({ kind: "click", x: c.x, y: c.y });
  }

  private async fillInput(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.exec({ kind: "type", text });
  }

  /** Native <select>: click focuses it, full-label typeahead lands the option. */
  private async fillSelect(selector: string, optionText: string): Promise<void> {
    await this.click(selector);
    await this.exec({ kind: "type", text: optionText });
  }

  /** <input type=date>: focus the first (month) segment, then type mmddyyyy. */
  private async fillDate(selector: string, iso: string): Promise<void> {
    const c = await leftOf(this.ctx.page, selector, 10);
    await this.exec({ kind: "click", x: c.x, y: c.y });
    await this.exec({ kind: "key", combo: "Home" });
    const [yy = "", mm = "", dd = ""] = iso.split("-");
    await this.exec({ kind: "type", text: `${mm}${dd}${yy}` });
  }

  /** A navigation-driving click, then a recorded wait so stub replay is nav-safe. */
  private async navClick(selector: string, pred: (url: string) => boolean): Promise<void> {
    await this.click(selector);
    await this.exec({ kind: "wait", ms: this.waitMs });
    await settleNav(this.ctx.page, pred);
  }

  async create(b: ExpectedBooking): Promise<void> {
    await this.navClick('nav a[href="/new"]', (u) => u.includes("/new"));
    await this.fillInput('input[name="customerName"]', b.customerName);
    await this.fillInput('input[name="phone"]', b.phone);
    await this.fillSelect('select[name="serviceType"]', b.serviceType);
    await this.fillDate('input[name="date"]', b.date);
    await this.fillSelect('select[name="time"]', b.time);
    await this.fillInput('input[name="address"]', b.addressLine);
    if (b.notes && b.notes.trim().length > 0) {
      await this.fillInput('input[name="notes"]', b.notes);
    }
    await this.navClick('button[type="submit"]', (u) => u.includes("/new/confirm"));
    await this.navClick('button[data-guard="irreversible"]', (u) => u.includes("/booking/"));
  }

  async reschedule(ref: string, date: string, time: string): Promise<void> {
    await this.navClick(`a[href="/booking/${ref}"]`, (u) => pathEquals(u, `/booking/${ref}`));
    await this.navClick(`a[href="/booking/${ref}/reschedule"]`, (u) => u.includes("/reschedule"));
    await this.fillDate('input[name="date"]', date);
    await this.fillSelect('select[name="time"]', time);
    await this.navClick('button[type="submit"]', (u) => u.includes("/reschedule/confirm"));
    await this.navClick('button[data-guard="irreversible"]', (u) => pathEquals(u, `/booking/${ref}`));
  }

  async cancel(ref: string): Promise<void> {
    await this.navClick(`a[href="/booking/${ref}"]`, (u) => pathEquals(u, `/booking/${ref}`));
    await this.navClick(`a[href="/booking/${ref}/cancel"]`, (u) => u.includes("/cancel"));
    await this.navClick('button[data-guard="irreversible"]', (u) => pathEquals(u, `/booking/${ref}`));
  }

  async done(summary: string): Promise<PolicyOutcome> {
    await this.exec({ kind: "done", summary });
    return { endReason: "done", steps: this.steps, summary };
  }

  async escalate(reason: string): Promise<PolicyOutcome> {
    await this.exec({ kind: "escalate", reason });
    return { endReason: "escalate", steps: this.steps, reason };
  }
}

function oracleEscalateReason(task: TaskSpec): string {
  return `Escalating (${task.title}). This request cannot be fulfilled safely from the available screens; a human should resolve it. No booking was made.`;
}

/** The oracle policy: derive the correct trajectory from the task's expectation. */
export function makeOraclePolicy(waitMs = 600): TrialPolicy {
  return {
    label: "oracle",
    async run(ctx: PolicyContext): Promise<PolicyOutcome> {
      const driver = new OracleDriver(ctx, waitMs);
      const exp = ctx.task.expectation;
      switch (exp.kind) {
        case "booking_created":
          await driver.create(exp.booking);
          return driver.done(`created booking for ${exp.booking.customerName}`);
        case "booking_rescheduled":
          await driver.reschedule(exp.ref, exp.booking.date, exp.booking.time);
          return driver.done(`rescheduled ${exp.ref} to ${exp.booking.date} ${exp.booking.time}`);
        case "booking_cancelled":
          await driver.cancel(exp.ref);
          return driver.done(`cancelled ${exp.ref}`);
        case "must_escalate":
          return driver.escalate(oracleEscalateReason(ctx.task));
      }
    },
  };
}

// --- Golden construction ----------------------------------------------------

export interface OracleResult {
  taskId: string;
  verdict: VerdictCode;
  trajectoryPath: string;
  steps: number;
}

export interface BuildGoldensOptions {
  taskIds?: string[];
  env?: HarnessEnv;
  goldensDir?: string;
}

export async function buildGoldens(opts: BuildGoldensOptions = {}): Promise<OracleResult[]> {
  const goldensDir = opts.goldensDir ?? "goldens";
  const ownEnv = opts.env ? null : await startHarnessEnv();
  const env = opts.env ?? (ownEnv as HarnessEnv);
  const policy = makeOraclePolicy();
  try {
    const tasks = buildTasks(env.anchor).filter(
      (t) => !opts.taskIds || opts.taskIds.includes(t.id),
    );
    const results: OracleResult[] = [];
    for (const task of tasks) {
      const trajectoryPath = join(goldensDir, `${task.id}.jsonl`);
      rmSync(trajectoryPath, { force: true }); // recorder appends; start each golden fresh
      const tr = await runTrial({
        task,
        trialIndex: 0,
        modelLabel: "oracle",
        policy,
        session: env.session,
        adminBase: env.adminBase,
        publicBase: env.publicBase,
        mailDir: env.mailDir,
        trajectoryPath,
      });
      if (!isSuccess(tr.verdict.code)) {
        throw new Error(
          `oracle golden for ${task.id} did not verify as a success (${tr.verdict.code}): ${tr.verdict.explanation}`,
        );
      }
      results.push({
        taskId: task.id,
        verdict: tr.verdict.code,
        trajectoryPath,
        steps: tr.steps,
      });
    }
    return results;
  } finally {
    if (ownEnv) await ownEnv.stop();
  }
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const results = await buildGoldens(ids.length > 0 ? { taskIds: ids } : {});
  for (const r of results) {
    process.stdout.write(`golden ${r.taskId}: ${r.verdict} (${r.steps} steps) -> ${r.trajectoryPath}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
