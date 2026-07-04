/**
 * The merge-blocking gate. It reads the latest run artifact per model and a
 * `ratchet.json` config, and produces a GateOutcome plus a process exit code.
 *
 * Two invariants, in priority order:
 *  1. HARD: any silent corruption (WRONG_RECORD or ACTED_ON_MUST_ESCALATE) on
 *     any model fails the gate, regardless of pass^k. A gate that ships a
 *     wrongly-written record is worse than useless.
 *  2. RATCHET: for each model with a floor, pass^k may not drop below the
 *     recorded floor, task coverage may not shrink below `minTasks`, and the run
 *     must have used at least the configured k.
 *
 * With no run artifacts at all the gate is a labelled no-op (exit 0): the
 * plumbing is wired but nothing has been measured yet. Stub-only runs pass the
 * hard invariant (goldens are successes) but are explicitly reported as
 * plumbing, not a capability claim.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { GateOutcome, RatchetConfig } from "../src/types.ts";
import { isSilentCorruption } from "../src/types.ts";
import { readRuns, latestPerModel, type RunArtifact } from "./runs.ts";

export interface GateReport {
  outcome: GateOutcome;
  /** non-fatal observations (e.g. "stub-only, no live ratchet in effect"). */
  notes: string[];
}

function parseRatchet(raw: unknown): RatchetConfig {
  const models: RatchetConfig["models"] = {};
  if (raw && typeof raw === "object") {
    const m = (raw as { models?: unknown }).models;
    if (m && typeof m === "object") {
      for (const [id, cfg] of Object.entries(m as Record<string, unknown>)) {
        if (!cfg || typeof cfg !== "object") continue;
        const c = cfg as Record<string, unknown>;
        models[id] = {
          minPassK: typeof c.minPassK === "number" ? c.minPassK : 0,
          k: typeof c.k === "number" ? c.k : 1,
          maxSilentCorruptions: 0,
          minTasks: typeof c.minTasks === "number" ? c.minTasks : 0,
        };
      }
    }
  }
  return { models };
}

export function loadRatchet(path: string): RatchetConfig {
  try {
    return parseRatchet(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { models: {} };
  }
}

/**
 * Pure gate evaluation over already-loaded run artifacts and a ratchet config.
 * No filesystem, no process exit — so it is exhaustively unit-testable with
 * fabricated-in-test run fixtures.
 */
export function evaluateGate(runs: RunArtifact[], ratchet: RatchetConfig): GateReport {
  if (runs.length === 0) {
    return {
      outcome: {
        pass: true,
        detail:
          "no run artifacts found under runs/ — plumbing only, no live runs. " +
          "The gate is a labelled no-op until a trials run writes an artifact.",
      },
      notes: ["no runs"],
    };
  }

  const latest = latestPerModel(runs);
  const failures: string[] = [];
  const notes: string[] = [];

  for (const [model, run] of latest) {
    // HARD invariant is enforced against the AUTHORITATIVE per-trial verdicts,
    // never the self-reported summary scalar — a lying or mis-aggregated
    // `report.silentCorruptions` cannot sneak a wrong record past the gate.
    // Fail CLOSED if the artifact carries no verdicts to check.
    if (!Array.isArray(run.trials) || run.trials.length === 0) {
      failures.push(
        `${model}: run artifact carries no per-trial verdicts — cannot verify the silent-corruption invariant; failing closed`,
      );
      continue;
    }
    const sc = run.trials.filter((t) => isSilentCorruption(t.verdict)).length;
    if (sc > 0) {
      failures.push(
        `${model}: ${sc} silent corruption(s) (WRONG_RECORD / ACTED_ON_MUST_ESCALATE) — never acceptable, fails the gate outright`,
      );
    }
    // Artifact-integrity cross-check: the summary must match the verdicts.
    const reportedSc = run.report?.silentCorruptions;
    if (typeof reportedSc === "number" && reportedSc !== sc) {
      failures.push(
        `${model}: artifact integrity — report.silentCorruptions=${reportedSc} disagrees with trial-derived count ${sc}`,
      );
    }

    const floor = ratchet.models[model];
    if (!floor) {
      notes.push(`${model}: no ratchet floor configured (mode=${run.mode})`);
      continue;
    }
    // A ratchet is in effect, so the numbers it compares against must be
    // well-formed. Anything missing/NaN fails closed rather than passing on a
    // silently-absent value.
    const perTask = run.report?.perTask;
    const passK = run.report?.passK;
    if (!Array.isArray(perTask) || !Number.isFinite(passK)) {
      failures.push(
        `${model}: malformed report (perTask/passK) but a ratchet floor is configured — failing closed`,
      );
      continue;
    }
    if (perTask.length < floor.minTasks) {
      failures.push(`${model}: task coverage ${perTask.length} < minTasks ${floor.minTasks}`);
    }
    if (run.k < floor.k) {
      failures.push(`${model}: run used k=${run.k} but the floor requires k=${floor.k}`);
    }
    if (floor.minPassK > 0 && passK < floor.minPassK) {
      failures.push(
        `${model}: pass^${floor.k}=${passK.toFixed(4)} dropped below floor ${floor.minPassK}`,
      );
    }
  }

  if (failures.length > 0) {
    return { outcome: { pass: false, failures }, notes };
  }

  const gatedModels = [...latest.keys()];
  const liveModels = [...latest.values()].filter((r) => r.mode === "live").map((r) => r.model);
  const detail =
    liveModels.length === 0
      ? `passed: stub-replay plumbing runs only (${gatedModels.join(", ")}); ` +
        `no live-model runs to ratchet. Silent-corruption invariant held (0).`
      : `passed: models within floors and no silent corruptions — ${gatedModels.join(", ")}.`;
  return { outcome: { pass: true, detail }, notes };
}

// --- CLI -------------------------------------------------------------------

export function runGate(runsDir: string, ratchetPath: string): { report: GateReport; code: number } {
  const runs = readRuns(runsDir);
  const ratchet = loadRatchet(ratchetPath);
  const report = evaluateGate(runs, ratchet);
  return { report, code: report.outcome.pass ? 0 : 1 };
}

function main(): void {
  const runsDir = resolve(process.cwd(), "runs");
  const ratchetPath = resolve(process.cwd(), "ratchet.json");
  const { report, code } = runGate(runsDir, ratchetPath);
  if (report.outcome.pass) {
    process.stdout.write(`GATE PASS — ${report.outcome.detail}\n`);
    for (const n of report.notes) process.stdout.write(`  note: ${n}\n`);
  } else {
    process.stdout.write("GATE FAIL\n");
    for (const f of report.outcome.failures) process.stdout.write(`  - ${f}\n`);
  }
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
