/**
 * Independent re-derivation of a run's verdicts.
 *
 * A trajectory's terminal line records the `Verdict` the harness computed. Any
 * check that reads that line back and calls the number "verified" proves
 * nothing — it is the harness marking its own homework. This module only ever
 * trusts the RAW witnesses persisted alongside it (`t: "witness"`: the captured
 * confirmation emails, the backend-state snapshot, the reset timestamp, the
 * agent's end reason and escalation reason) and re-executes
 * `groundtruth/verifier.ts` over them.
 *
 * Three things are checked per trial, and any one of them failing is fatal:
 *   1. the witnesses re-derive to the verdict recorded in the trajectory;
 *   2. they re-derive to the verdict recorded in the run artifact;
 *   3. the expectation they were graded against is the one the task suite
 *      actually defines at that trial's anchor — otherwise a run could be made
 *      to pass by moving the goalposts instead of by faking a witness.
 *
 * A trial whose trajectory is missing or carries no witness line is reported
 * `unauditable` and fails the audit. Silence is not a pass.
 *
 * Usage: `npm run audit -- <run.json | runs-dir | trajectory.jsonl>`
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";

import type {
  TaskExpectation,
  TrajectoryLine,
  VerdictCode,
  WitnessSnapshot,
} from "../src/types.ts";
import { verify } from "../groundtruth/verifier.ts";
import { buildTasks } from "./tasks.ts";
import type { RunArtifact } from "./runs.ts";

/**
 * `absent` is distinct from `unauditable` on purpose. A live run's trajectories
 * are CI artifacts, not repo contents, so a fresh checkout genuinely has no
 * evidence to re-derive from — that is a fact to state, not a failure. A
 * trajectory that IS present but carries no witness line, or is present and
 * disagrees, is a real problem and fails the audit.
 */
export type AuditStatus = "agree" | "disagree" | "unauditable" | "absent";

export interface TrialAudit {
  taskId: string;
  trajectoryPath: string;
  /** verdict recorded in the trajectory's terminal line. */
  recorded: VerdictCode | undefined;
  /** verdict re-derived here from the raw witnesses. */
  recomputed: VerdictCode | undefined;
  /** verdict recorded in the run artifact, when auditing a run. */
  artifactVerdict?: VerdictCode;
  status: AuditStatus;
  detail: string;
}

export interface RunAudit {
  runPath: string;
  model: string;
  audits: TrialAudit[];
  disagreements: number;
  unauditable: number;
  /** trials whose trajectory file is not in this checkout at all. */
  absent: number;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Per-trajectory audit
// ---------------------------------------------------------------------------

interface ParsedTrajectory {
  taskId?: string;
  witness?: WitnessSnapshot;
  recorded?: VerdictCode;
}

function parseTrajectory(path: string): ParsedTrajectory {
  const out: ParsedTrajectory = {};
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: TrajectoryLine;
    try {
      parsed = JSON.parse(line) as TrajectoryLine;
    } catch {
      continue; // a malformed line cannot supply evidence; absence is caught below
    }
    if (parsed.t === "header") out.taskId = parsed.v.taskId;
    else if (parsed.t === "witness") out.witness = parsed.v;
    else if (parsed.t === "terminal") out.recorded = parsed.v.verdict.code;
  }
  return out;
}

/** Re-execute the verifier over a persisted witness snapshot. */
export function recomputeFromWitness(w: WitnessSnapshot): VerdictCode {
  return verify({
    expectation: w.expectation,
    endReason: w.endReason,
    emails: w.emails,
    db: w.db,
    resetAt: w.resetAt,
    ...(w.reason !== undefined ? { reason: w.reason } : {}),
  }).code;
}

/**
 * Confirm the expectation a trial was graded against is the one the suite
 * defines for that task at that anchor. Tasks promoted from failures are not in
 * the base suite; those are reported as un-cross-checkable rather than wrong.
 */
function expectationMatchesSuite(
  taskId: string,
  anchor: string,
  expectation: TaskExpectation,
): { ok: boolean; note: string } {
  let suite;
  try {
    suite = buildTasks(anchor);
  } catch (err) {
    return { ok: false, note: `could not rebuild the suite at anchor ${anchor}: ${String(err)}` };
  }
  const task = suite.find((t) => t.id === taskId);
  if (!task) return { ok: true, note: `task ${taskId} is not in the base suite (promoted?)` };
  if (!isDeepStrictEqual(task.expectation, expectation)) {
    return {
      ok: false,
      note: `expectation does not match the suite definition for ${taskId} at anchor ${anchor}`,
    };
  }
  return { ok: true, note: "expectation matches the suite" };
}

export function auditTrajectoryFile(path: string): TrialAudit {
  const base: TrialAudit = {
    taskId: "(unknown)",
    trajectoryPath: path,
    recorded: undefined,
    recomputed: undefined,
    status: "unauditable",
    detail: "",
  };

  if (!existsSync(path)) {
    return {
      ...base,
      status: "absent",
      detail: "trajectory not present in this checkout (live-run evidence is a CI artifact)",
    };
  }

  const parsed = parseTrajectory(path);
  const taskId = parsed.taskId ?? "(unknown)";
  if (!parsed.witness) {
    return {
      ...base,
      taskId,
      recorded: parsed.recorded,
      detail:
        "no witness line: this trajectory records only a computed verdict, so it cannot be re-derived",
    };
  }

  const recomputed = recomputeFromWitness(parsed.witness);
  const exp = expectationMatchesSuite(taskId, parsed.witness.anchor, parsed.witness.expectation);
  if (!exp.ok) {
    return {
      ...base,
      taskId,
      recorded: parsed.recorded,
      recomputed,
      status: "disagree",
      detail: exp.note,
    };
  }

  if (parsed.recorded === undefined) {
    return {
      ...base,
      taskId,
      recomputed,
      detail: "no terminal line: nothing recorded to compare the re-derivation against",
    };
  }

  if (parsed.recorded !== recomputed) {
    return {
      taskId,
      trajectoryPath: path,
      recorded: parsed.recorded,
      recomputed,
      status: "disagree",
      detail: `recorded ${parsed.recorded} but the raw witnesses re-derive to ${recomputed}`,
    };
  }

  return {
    taskId,
    trajectoryPath: path,
    recorded: parsed.recorded,
    recomputed,
    status: "agree",
    detail: `re-derived ${recomputed} from raw witnesses (${exp.note})`,
  };
}

// ---------------------------------------------------------------------------
// Whole-run audit
// ---------------------------------------------------------------------------

export function auditRun(artifact: RunArtifact, runPath: string): RunAudit {
  const audits: TrialAudit[] = [];
  for (const trial of artifact.trials) {
    const audit = auditTrajectoryFile(trial.trajectoryPath);
    audit.taskId = audit.taskId === "(unknown)" ? trial.taskId : audit.taskId;
    audit.artifactVerdict = trial.verdict;
    // The artifact is what the gate reads, so it must agree with the
    // re-derivation too — editing it is the cheapest way to fake a pass.
    if (audit.status === "agree" && trial.verdict !== audit.recomputed) {
      audit.status = "disagree";
      audit.detail = `run artifact records ${trial.verdict} but the raw witnesses re-derive to ${audit.recomputed}`;
    }
    audits.push(audit);
  }
  const disagreements = audits.filter((a) => a.status === "disagree").length;
  const unauditable = audits.filter((a) => a.status === "unauditable").length;
  const absent = audits.filter((a) => a.status === "absent").length;
  return {
    runPath,
    model: artifact.model,
    audits,
    disagreements,
    unauditable,
    absent,
    ok: disagreements === 0 && unauditable === 0 && audits.length > 0,
  };
}

export function auditRunArtifact(runPath: string): RunAudit {
  const artifact = JSON.parse(readFileSync(runPath, "utf8")) as RunArtifact;
  return auditRun(artifact, runPath);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function renderRunAudit(r: RunAudit): string {
  const lines: string[] = [];
  lines.push(`run: ${r.runPath}`);
  lines.push(`model: ${r.model}   trials: ${r.audits.length}`);
  for (const a of r.audits) {
    if (a.status === "agree" || a.status === "absent") continue;
    lines.push(`  [FAIL] ${a.taskId}: ${a.detail}`);
  }
  const agreed = r.audits.filter((a) => a.status === "agree").length;
  lines.push(
    `  ${agreed} re-derived and agreed, ${r.disagreements} disagreed, ` +
      `${r.unauditable} unauditable, ${r.absent} evidence absent`,
  );
  if (r.absent === r.audits.length && r.audits.length > 0) {
    lines.push(
      "  note: no trajectories for this run in this checkout — nothing was re-derived",
    );
  }
  return lines.join("\n");
}

/** Expand a target into the run-artifact / trajectory files it names. */
function expandTargets(targets: string[]): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const path = resolve(t);
    if (!existsSync(path)) {
      console.error(`audit: no such path: ${path}`);
      process.exitCode = 2;
      continue;
    }
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name.endsWith(".json")) out.push(join(path, name));
      }
    } else {
      out.push(path);
    }
  }
  return out;
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    console.error("usage: npm run audit -- <run.json | runs-dir | trajectory.jsonl> ...");
    process.exitCode = 2;
    return;
  }

  const files = expandTargets(argv);
  if (files.length === 0) {
    console.error("audit: nothing to audit");
    process.exitCode = 2;
    return;
  }

  let failed = false;
  let rederived = 0;
  for (const file of files) {
    if (file.endsWith(".jsonl")) {
      const a = auditTrajectoryFile(file);
      console.log(`${a.status.toUpperCase()} ${a.taskId}: ${a.detail}`);
      if (a.status === "agree") rederived += 1;
      else failed = true;
      continue;
    }
    let r: RunAudit;
    try {
      r = auditRunArtifact(file);
    } catch (err) {
      console.error(`audit: ${file} is not a readable run artifact: ${String(err)}`);
      failed = true;
      continue;
    }
    console.log(renderRunAudit(r));
    rederived += r.audits.filter((a) => a.status === "agree").length;
    if (!r.ok) failed = true;
  }

  if (failed) {
    console.error("\naudit FAILED: a recorded verdict does not re-derive from its raw witnesses");
    process.exitCode = 1;
    return;
  }
  // An audit that re-derived nothing has verified nothing. Reporting OK here
  // would be the same class of error this whole module exists to prevent, so it
  // exits nonzero instead — a green CI step must mean evidence was checked.
  if (rederived === 0) {
    console.error(
      "\naudit INCONCLUSIVE: no verdict was re-derived (no witness evidence present) — nothing was verified",
    );
    process.exitCode = 2;
    return;
  }
  console.log(`\naudit OK: ${rederived} verdict(s) re-derived from raw witnesses`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
