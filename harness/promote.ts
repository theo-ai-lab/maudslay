/**
 * Failure-to-golden promotion. When a trial fails, the failing task is worth
 * keeping as a permanent regression: promotion derives a new TaskSpec variant
 * from the base task and the failing trajectory, and appends it to a persistent
 * registry (`goldens/promoted-tasks.json`) that the suite folds in on the next
 * run. The expectation is preserved verbatim — the point of a regression is to
 * re-demand exactly the outcome the model got wrong.
 *
 * `buildPromotedTask` is pure so promotion is unit-testable without a run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { TaskSpec, VerdictCode } from "../src/types.ts";
import type { TrajectoryLine } from "../src/types.ts";
import { buildTasks, findTask } from "./tasks.ts";
import { computeAnchor } from "../sim/seed.ts";

export interface PromotedTask {
  task: TaskSpec;
  provenance: {
    promotedFrom: string; // base task id
    verdict: VerdictCode;
    trajectoryPath: string;
    promotedAt: string; // ISO
  };
}

/**
 * Derive a regression TaskSpec from a base task, the observed failing verdict,
 * and the trajectory that produced it. The variant keeps the base expectation
 * and seed; only its id and tags change so it is addressable as a distinct
 * regression while re-demanding the same outcome.
 */
export function buildPromotedTask(
  base: TaskSpec,
  verdict: VerdictCode,
  trajectoryPath: string,
  promotedAt: string,
  index: number,
): PromotedTask {
  const suffix = `regress-${String(index).padStart(3, "0")}`;
  const task: TaskSpec = {
    id: `${base.id}#${suffix}`,
    title: `${base.title} (regression from ${verdict})`,
    instruction: base.instruction,
    expectation: base.expectation,
    seed: base.seed,
    actionBudget: base.actionBudget,
    tags: [...base.tags.filter((t) => t !== "promoted"), "promoted", "regression"],
  };
  return {
    task,
    provenance: { promotedFrom: base.id, verdict, trajectoryPath, promotedAt },
  };
}

/** Read the terminal verdict from a trajectory JSONL, if it has a terminal line. */
export function readTrajectoryVerdict(path: string): VerdictCode | undefined {
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
      if (parsed.t === "terminal") return parsed.v.verdict.code;
    } catch {
      // skip malformed lines
    }
  }
  return undefined;
}

export function loadPromoted(path: string): PromotedTask[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as PromotedTask[]) : [];
  } catch {
    return [];
  }
}

export function savePromoted(path: string, list: PromotedTask[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2));
}

/**
 * Promote a failing trial into the registry: append a regression variant and
 * return the updated list. Refuses to promote a verdict that is a success, and
 * refuses to duplicate an already-promoted trajectory.
 */
export function promoteFailure(
  registryPath: string,
  base: TaskSpec,
  verdict: VerdictCode,
  trajectoryPath: string,
  promotedAt: string,
): { added: boolean; reason?: string; list: PromotedTask[] } {
  const existing = loadPromoted(registryPath);
  if (verdict === "OK" || verdict === "ESCALATED_OK") {
    return { added: false, reason: `verdict ${verdict} is a success — nothing to promote`, list: existing };
  }
  if (existing.some((p) => p.provenance.trajectoryPath === trajectoryPath)) {
    return { added: false, reason: "trajectory already promoted", list: existing };
  }
  const sameBase = existing.filter((p) => p.provenance.promotedFrom === base.id).length;
  const promoted = buildPromotedTask(base, verdict, trajectoryPath, promotedAt, sameBase + 1);
  const list = [...existing, promoted];
  savePromoted(registryPath, list);
  return { added: true, list };
}

export const PROMOTED_REGISTRY = "goldens/promoted-tasks.json";

function main(): void {
  const [taskId, trajectoryPath] = process.argv.slice(2);
  if (!taskId || !trajectoryPath) {
    process.stderr.write("usage: node harness/promote.ts <taskId> <trajectoryPath>\n");
    process.exit(2);
  }
  const base = findTask(buildTasks(computeAnchor()), taskId);
  if (!base) {
    process.stderr.write(`unknown task id: ${taskId}\n`);
    process.exit(2);
  }
  const verdict = readTrajectoryVerdict(trajectoryPath);
  if (!verdict) {
    process.stderr.write(`no terminal verdict found in ${trajectoryPath}\n`);
    process.exit(2);
  }
  const registry = resolve(process.cwd(), PROMOTED_REGISTRY);
  const res = promoteFailure(registry, base, verdict, trajectoryPath, new Date().toISOString());
  if (res.added) {
    const last = res.list[res.list.length - 1] as PromotedTask;
    process.stdout.write(`promoted ${taskId} (${verdict}) -> ${last.task.id}\n`);
  } else {
    process.stdout.write(`not promoted: ${res.reason}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
