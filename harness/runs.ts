/**
 * Run artifacts — the on-disk record a trials run leaves under `runs/`, and the
 * only thing the gate and report ever read. Keeping a single typed shape here
 * lets `gate.ts`, `report.ts`, and `promote.ts` share one reader and one notion
 * of "latest run per model" without re-deriving anything.
 *
 * A run artifact is self-describing: it carries the pass^k report (all numbers
 * derived, never hand-written), the per-trial index, and — critically — its
 * `mode`. A `stub` run is a plumbing/determinism check (golden replay); a `live`
 * run is a model-capability measurement. The gate and report treat them
 * differently, so provenance travels with the data.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PassKReport, VerdictCode } from "../src/types.ts";

export const RUN_SCHEMA = "maudslay.run/1";

export interface RunTrialRecord {
  taskId: string;
  trialIndex: number;
  verdict: VerdictCode;
  steps: number;
  durationMs: number;
  trajectoryPath: string;
}

export interface RunArtifact {
  schema: string;
  /** model id, or "stub" for a golden-replay plumbing run. */
  model: string;
  /** "stub" = golden replay (plumbing); "live" = real model capability. */
  mode: "stub" | "live";
  k: number;
  generatedAt: string; // ISO
  report: PassKReport;
  trials: RunTrialRecord[];
}

/** Write a run artifact to `dir` with a filesystem-safe, sortable filename. */
export function writeRun(dir: string, artifact: RunArtifact): string {
  mkdirSync(dir, { recursive: true });
  const tsSafe = artifact.generatedAt.replace(/[:.]/g, "-");
  const path = join(dir, `${artifact.model}-${tsSafe}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  return path;
}

function looksLikeRun(v: unknown): v is RunArtifact {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.model === "string" &&
    (o.mode === "stub" || o.mode === "live") &&
    typeof o.k === "number" &&
    typeof o.generatedAt === "string" &&
    typeof o.report === "object" &&
    o.report !== null &&
    // The gate verifies its hard invariant from per-trial verdicts, so a run
    // without a trials array is not a usable artifact.
    Array.isArray(o.trials)
  );
}

/**
 * Read every run artifact from `dir`, separating well-formed runs from `.json`
 * files that exist but cannot be trusted (unparseable, or parseable but not a
 * run artifact). A half-written or tampered artifact is a fact worth surfacing,
 * not noise: the gate treats every `invalid` entry as fatal, because a corrupted
 * measurement that silently vanishes would leave its ratchet floor unenforced.
 */
export function readRunsAudit(dir: string): {
  runs: RunArtifact[];
  invalid: string[];
  problems: string[];
} {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    // A MISSING directory is the bootstrap case (nothing measured yet). Any
    // other readdir failure (permissions, I/O) means committed measurements
    // exist but cannot be seen — every artifact vanishing at once must never
    // read as "nothing measured".
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { runs: [], invalid: [], problems: [] };
    }
    return {
      runs: [],
      invalid: [],
      problems: [
        `runs directory at ${dir} exists but is unreadable (${(e as NodeJS.ErrnoException).code ?? "error"}) — failing closed`,
      ],
    };
  }
  const runs: RunArtifact[] = [];
  const invalid: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (looksLikeRun(parsed)) runs.push(parsed);
      else invalid.push(name);
    } catch {
      invalid.push(name);
    }
  }
  return { runs, invalid, problems: [] };
}

/**
 * Read every well-formed run artifact from `dir`; malformed files are skipped.
 * This is the rendering/promotion surface (report, promote). The gate must use
 * `readRunsAudit` instead so malformed files fail closed rather than vanish.
 */
export function readRuns(dir: string): RunArtifact[] {
  return readRunsAudit(dir).runs;
}

/** The most recent artifact per model id, keyed by model, latest `generatedAt`. */
export function latestPerModel(runs: RunArtifact[]): Map<string, RunArtifact> {
  const latest = new Map<string, RunArtifact>();
  for (const run of runs) {
    const prev = latest.get(run.model);
    if (!prev || run.generatedAt > prev.generatedAt) latest.set(run.model, run);
  }
  return latest;
}
