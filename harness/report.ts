/**
 * Render a per-model markdown table straight from the run artifacts under
 * `runs/`. Every cell is read from an artifact — there is no path by which a
 * number can be typed in by hand. With no artifacts the table renders
 * "pending live run", and stub-replay rows are labelled as plumbing so a reader
 * never mistakes a determinism check for a capability measurement.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readRuns, latestPerModel, type RunArtifact } from "./runs.ts";

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function modeLabel(mode: RunArtifact["mode"]): string {
  return mode === "stub" ? "stub (plumbing)" : "live";
}

/**
 * Render the report as markdown. Pure over the artifacts passed in; empty input
 * yields the honest "pending" placeholder rather than an empty table.
 */
export function renderReport(runs: RunArtifact[]): string {
  const lines: string[] = ["## Per-model results", ""];

  if (runs.length === 0) {
    lines.push("_Pending live run — no run artifacts found under `runs/`._");
    lines.push("");
    return lines.join("\n");
  }

  const latest = [...latestPerModel(runs).values()].sort((a, b) =>
    a.model < b.model ? -1 : a.model > b.model ? 1 : 0,
  );

  lines.push(
    "| Model | Mode | k | Tasks | pass^k | Per-trial pass | 95% lower bound | Trials | Silent corruptions | Escalation rate |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const run of latest) {
    const r = run.report;
    lines.push(
      `| ${run.model} | ${modeLabel(run.mode)} | ${run.k} | ${r.perTask.length} | ` +
        `${pct(r.passK)} | ${pct(r.perTrialPassRate)} | ${pct(r.perTrialLowerBound95)} | ` +
        `${r.trialsTotal} | ${r.silentCorruptions} | ${pct(r.escalationRate)} |`,
    );
  }
  lines.push("");

  const hasLive = latest.some((r) => r.mode === "live");
  if (!hasLive) {
    lines.push(
      "_Rows above are stub-replay plumbing runs (golden determinism), not a model-capability claim. " +
        "Live-model pass^k: pending live run._",
    );
    lines.push("");
  }
  const corrupt = latest.filter((r) => r.report.silentCorruptions > 0);
  if (corrupt.length > 0) {
    lines.push(
      `**Silent corruptions present** in: ${corrupt.map((r) => r.model).join(", ")} — these fail the gate.`,
    );
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  const runsDir = resolve(process.cwd(), "runs");
  process.stdout.write(`${renderReport(readRuns(runsDir))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
