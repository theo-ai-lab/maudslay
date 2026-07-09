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
import { createHash } from "node:crypto";
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
  /** sha256 of each artifact's raw bytes, keyed `${model}\n${generatedAt}` — feeds content-addressed ratchet pins. */
  shas: Map<string, string>;
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
      return { runs: [], invalid: [], problems: [], shas: new Map() };
    }
    return {
      runs: [],
      invalid: [],
      problems: [
        `runs directory at ${dir} exists but is unreadable (${(e as NodeJS.ErrnoException).code ?? "error"}) — failing closed`,
      ],
      shas: new Map(),
    };
  }
  const runs: RunArtifact[] = [];
  const invalid: string[] = [];
  const problems: string[] = [];
  const shas = new Map<string, string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const bytes = readFileSync(join(dir, name));
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (looksLikeRun(parsed)) {
        const key = `${parsed.model}\n${parsed.generatedAt}`;
        // Two artifacts sharing a (model, generatedAt) identity collide the sha
        // map and would let one silently shadow the other's content pin. The
        // writeRun filename is derived from exactly that identity, so a
        // collision only happens when a file was added by hand — fail closed.
        if (shas.has(key)) {
          problems.push(
            `two run artifacts share model=${parsed.model} generatedAt=${parsed.generatedAt} — ` +
              `an ambiguous identity that would shadow a content pin; failing closed`,
          );
        }
        runs.push(parsed);
        shas.set(key, createHash("sha256").update(bytes).digest("hex"));
      } else {
        invalid.push(name);
      }
    } catch {
      invalid.push(name);
    }
  }
  return { runs, invalid, problems, shas };
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
