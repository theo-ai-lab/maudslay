/**
 * The merge-blocking gate. It reads the latest run artifact per model and a
 * `ratchet.json` config, and produces a GateOutcome plus a process exit code.
 *
 * Three invariants, in priority order:
 *  1. HARD: any silent corruption (WRONG_RECORD or ACTED_ON_MUST_ESCALATE) on
 *     any model fails the gate, regardless of pass^k. A gate that ships a
 *     wrongly-written record is worse than useless.
 *  2. RATCHET: for each model with a floor, pass^k may not drop below the
 *     recorded floor, task coverage may not shrink below `minTasks`, and the run
 *     must have used at least the configured k.
 *  3. FAIL-CLOSED INPUTS: an artifact file that exists but cannot be read as a
 *     run; a ratchet config that exists but is corrupt or carries mistyped
 *     floor fields; a configured floor (minPassK > 0) with no artifact, with a
 *     stub-mode artifact, with tasks carrying fewer than k trial records, or
 *     with a report.passK that disagrees with the trial-derived pass^k — all
 *     fail the gate. Deleting, corrupting, or inflating a measurement (or the
 *     config that carries its floor) must never silently un-enforce it.
 *
 * With no run artifacts at all — and nothing ratcheted — the gate is a labelled
 * no-op (exit 0): the plumbing is wired but nothing has been measured yet.
 * Stub-only runs pass the hard invariant (goldens are successes) but are
 * explicitly reported as plumbing, not a capability claim.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { GateOutcome, RatchetConfig } from "../src/types.ts";
import { isSilentCorruption, isSuccess } from "../src/types.ts";
import { loadRatchetAudit } from "./ratchet.ts";
export { loadRatchet, loadRatchetAudit, parseRatchet } from "./ratchet.ts";
import {
  readRunsAudit,
  latestPerModel,
  type RunArtifact,
  type RunTrialRecord,
} from "./runs.ts";

export interface GateReport {
  outcome: GateOutcome;
  /** non-fatal observations (e.g. "stub-only, no live ratchet in effect"). */
  notes: string[];
}

/**
 * Pure gate evaluation over already-loaded run artifacts and a ratchet config.
 * No filesystem, no process exit — so it is exhaustively unit-testable with
 * fabricated-in-test run fixtures. `invalidFiles` carries the names of artifact
 * files that exist on disk but could not be read as runs (see `readRunsAudit`);
 * each one fails the gate outright.
 */
export function evaluateGate(
  runs: RunArtifact[],
  ratchet: RatchetConfig,
  invalidFiles: string[] = [],
  configProblems: string[] = [],
  /** sha256 of each artifact's raw file bytes, keyed `${model}\n${generatedAt}`. */
  contentShas: Map<string, string> = new Map(),
): GateReport {
  const latest = latestPerModel(runs);
  const failures: string[] = [];
  const notes: string[] = [];

  // FAIL-CLOSED: an artifact file that cannot be read as a run is a fact, not
  // noise — silently skipping it would let a corrupted measurement pass the
  // gate with its floor unenforced.
  for (const name of invalidFiles) {
    failures.push(
      `${name}: unreadable or malformed run artifact — failing closed; delete or regenerate it`,
    );
  }

  // FAIL-CLOSED: the ratchet config is the floors' carrier and gets the same
  // treatment as the artifacts it governs (see loadRatchetAudit).
  failures.push(...configProblems);

  // FAIL-CLOSED: a measured pass^k floor (minPassK > 0) is a promise that a
  // live measurement exists. If no artifact for that model is present, the
  // floor cannot be enforced and the gate must not pretend it was. (Entries
  // with minPassK = 0 are unmeasured models awaiting their first live run —
  // requiring artifacts for them would break the documented bootstrap.)
  for (const [model, floor] of Object.entries(ratchet.models)) {
    if (!latest.has(model)) {
      if (floor.minPassK > 0) {
        failures.push(
          `${model}: ratchet floor minPassK=${floor.minPassK} is configured but no run artifact ` +
            `is present — the floor cannot be enforced; failing closed`,
        );
      } else {
        // A dormant entry (unmeasured model awaiting its first live run) is
        // legitimate — but its absence must be VISIBLE, so deleting a
        // measurement for a minPassK=0 model is never fully silent.
        notes.push(
          `${model}: ratchet entry configured but no run artifact present (unmeasured — floors dormant)`,
        );
      }
    }
  }

  // FAIL-CLOSED: a pinned artifact locks the exact measurement a floor is read
  // against. The selected latest MUST equal the pin — if it is older, the pinned
  // newest was deleted and an older passing run rolled in (the G5 residual); if
  // it is newer, a measurement superseded the pin without a deliberate re-pin.
  // Either way the operator must update ratchet.json, which is visible in the diff.
  for (const [model, floor] of Object.entries(ratchet.models)) {
    const pin = floor.pinnedArtifact;
    if (!pin) continue;
    const run = latest.get(model);
    if (!run) {
      failures.push(
        `${model}: ratchet pins artifact generatedAt=${pin.generatedAt} but no run for this model is present — ` +
          `the pinned measurement is gone; failing closed`,
      );
    } else if (run.generatedAt !== pin.generatedAt) {
      failures.push(
        `${model}: ratchet pins artifact generatedAt=${pin.generatedAt} but the latest artifact is ` +
          `${run.generatedAt} — a deleted-newest rollback or an un-repinned supersession; failing closed`,
      );
    } else if (pin.sha256 !== undefined) {
      // Content-addressed pin: the selected artifact's raw bytes must hash to the
      // pinned digest, so a different artifact re-using the pinned generatedAt
      // (or an edit to the pinned one) fails closed. A missing sha (the map was
      // not supplied, e.g. a pure unit test) also fails closed — a content pin
      // that cannot be checked must never pass.
      const actual = contentShas.get(`${model}\n${run.generatedAt}`);
      if (actual !== pin.sha256) {
        failures.push(
          `${model}: ratchet pins artifact sha256=${pin.sha256} but the selected artifact hashes to ` +
            `${actual ?? "<unavailable>"} — content mismatch or unverifiable pin; failing closed`,
        );
      }
    }
  }

  if (runs.length === 0 && failures.length === 0) {
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
    if (floor.minPassK > 0) {
      // A capability floor can only be satisfied by a LIVE measurement — a
      // golden-replay plumbing run is deterministic by construction and must
      // never stand in for model capability.
      if (run.mode !== "live") {
        failures.push(
          `${model}: ratchet floor minPassK=${floor.minPassK} requires a live run artifact, ` +
            `but the latest artifact is mode=${run.mode} (plumbing replay) — failing closed`,
        );
        continue;
      }
      // The RATCHET invariant gets the same treatment as the HARD invariant:
      // recompute pass^k AND task coverage from the AUTHORITATIVE per-trial
      // verdicts and cross-check every self-reported summary, so deleting a
      // failing trial, deleting a whole failing task, padding with duplicate
      // records, or inflating report.passK cannot satisfy a floor.
      const byTask = new Map<string, RunTrialRecord[]>();
      for (const t of run.trials) {
        const arr = byTask.get(t.taskId) ?? [];
        arr.push(t);
        byTask.set(t.taskId, arr);
      }
      // k trials means k DISTINCT trials: unique trial indexes, not record
      // count — a duplicated passing record cannot stand in for a deleted one.
      const underK = [...byTask.entries()].filter(
        ([, ts]) => new Set(ts.map((t) => t.trialIndex)).size < run.k,
      );
      if (underK.length > 0) {
        failures.push(
          `${model}: ${underK.length} task(s) carry fewer than k=${run.k} distinct trial ` +
            `records — pass^k cannot be verified from the trials; failing closed`,
        );
      }
      // Coverage is trial-derived too: the self-reported perTask cannot vouch
      // for tasks whose records were erased wholesale.
      if (byTask.size !== perTask.length) {
        failures.push(
          `${model}: artifact integrity — report.perTask lists ${perTask.length} task(s) ` +
            `but the trial records carry ${byTask.size}`,
        );
      }
      if (byTask.size < floor.minTasks) {
        failures.push(
          `${model}: trial-derived task coverage ${byTask.size} < minTasks ${floor.minTasks}`,
        );
      }
      const tasks = [...byTask.values()];
      const derived =
        tasks.length === 0
          ? 0
          : tasks.filter((ts) => ts.every((t) => isSuccess(t.verdict))).length / tasks.length;
      if (Math.abs(derived - passK) > 1e-9) {
        failures.push(
          `${model}: artifact integrity — report.passK=${passK.toFixed(4)} disagrees with ` +
            `trial-derived pass^k ${derived.toFixed(4)}`,
        );
      }
      if (passK < floor.minPassK) {
        failures.push(
          `${model}: pass^${floor.k}=${passK.toFixed(4)} dropped below floor ${floor.minPassK}`,
        );
      }
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
  const { runs, invalid, problems: runProblems, shas } = readRunsAudit(runsDir);
  const { config, problems: configProblems } = loadRatchetAudit(ratchetPath);
  const report = evaluateGate(runs, config, invalid, [...runProblems, ...configProblems], shas);
  return { report, code: report.outcome.pass ? 0 : 1 };
}

export const GATE_USAGE =
  "usage: npm run gate [-- --json] [-- --help]\n" +
  "  Reads runs/ and ratchet.json, evaluates the merge-blocking gate, and exits\n" +
  "  0 (pass) or 1 (fail).\n" +
  "  --json   emit the gate report as a single JSON object (for CI consumers)\n" +
  "  --help   print this message and exit 0\n" +
  "  For clean JSON on stdout, call `node harness/gate.ts --json` directly\n" +
  "  (or `npm run --silent gate -- --json`) so npm's run banner is suppressed.";

/** Machine-readable gate result — stable shape for CI consumers. The exit code
 * is DERIVED from the report so a caller can never emit a contradictory
 * `pass:false, code:0`. */
export function toGateJson(report: GateReport): {
  pass: boolean;
  code: number;
  detail: string | null;
  failures: string[];
  notes: string[];
} {
  return {
    pass: report.outcome.pass,
    code: report.outcome.pass ? 0 : 1,
    detail: report.outcome.pass ? report.outcome.detail : null,
    failures: report.outcome.pass ? [] : report.outcome.failures,
    notes: report.notes,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${GATE_USAGE}\n`);
    process.exit(0);
  }
  const runsDir = resolve(process.cwd(), "runs");
  const ratchetPath = resolve(process.cwd(), "ratchet.json");
  const { report, code } = runGate(runsDir, ratchetPath);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(toGateJson(report))}\n`);
    process.exit(code);
  }
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
