/**
 * Trials CLI. Runs k trials per task for one model and writes a run artifact to
 * `runs/<model>-<ts>.json` that the gate and report read.
 *
 *   node harness/trial-cli.ts --model stub --k 1 --tasks all
 *   node harness/trial-cli.ts --model claude-fable-5 --k 5 --tasks book-simple-001
 *
 * `--model stub` replays the goldens (deterministic plumbing, no key); any other
 * model id runs the live loop and requires ANTHROPIC_API_KEY. Nothing is
 * fabricated: the artifact's numbers all come from the trials just run.
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelConfig, ModelId, TrialResult } from "../src/types.ts";
import { VAR_DIRS } from "../src/types.ts";
import { buildTasks } from "./tasks.ts";
import {
  startHarnessEnv,
  runTrial,
  makeStubPolicy,
  makeLivePolicy,
  type TrialPolicy,
} from "./trial.ts";
import { buildPassKReport } from "./passk.ts";
import { writeRun, RUN_SCHEMA, type RunArtifact, type RunTrialRecord } from "./runs.ts";

interface CliArgs {
  model: string;
  k: number;
  tasks: string; // "all" or comma-separated ids
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { model: "stub", k: 1, tasks: "all" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.model = argv[++i] ?? args.model;
    else if (a === "--k") args.k = Math.max(1, Number.parseInt(argv[++i] ?? "1", 10) || 1);
    else if (a === "--tasks") args.tasks = argv[++i] ?? args.tasks;
    else if (a?.startsWith("--model=")) args.model = a.slice("--model=".length);
    else if (a?.startsWith("--k=")) args.k = Math.max(1, Number.parseInt(a.slice("--k=".length), 10) || 1);
    else if (a?.startsWith("--tasks=")) args.tasks = a.slice("--tasks=".length);
  }
  return args;
}

const API_MODELS: ModelId[] = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"];

function isApiModel(model: string): model is ModelId {
  return (API_MODELS as string[]).includes(model);
}

function liveConfig(model: ModelId): ModelConfig {
  return {
    model,
    effort: "high",
    fallbackToOpus: model === "claude-fable-5",
    maxTokensPerTurn: 4096,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode: RunArtifact["mode"] = args.model === "stub" ? "stub" : "live";

  if (mode === "live" && !isApiModel(args.model)) {
    process.stderr.write(
      `unknown model '${args.model}'. Use 'stub' or one of: ${API_MODELS.join(", ")}\n`,
    );
    process.exit(2);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (mode === "live" && !apiKey) {
    process.stderr.write(
      "live trials require ANTHROPIC_API_KEY (this is the key-gated path). Aborting.\n",
    );
    process.exit(2);
  }

  const env = await startHarnessEnv();
  try {
    const suite = buildTasks(env.anchor);
    const tasks =
      args.tasks === "all"
        ? suite
        : suite.filter((t) => args.tasks.split(",").map((s) => s.trim()).includes(t.id));
    if (tasks.length === 0) {
      process.stderr.write(`no tasks matched '${args.tasks}'\n`);
      process.exit(2);
    }

    const results: TrialResult[] = [];
    for (const task of tasks) {
      const policy: TrialPolicy =
        mode === "stub"
          ? makeStubPolicy(join("goldens", `${task.id}.jsonl`))
          : makeLivePolicy(liveConfig(args.model as ModelId), apiKey ? { apiKey } : {});
      for (let i = 0; i < args.k; i++) {
        const trajectoryPath = join(VAR_DIRS.trajectories, args.model, `${task.id}-${i}.jsonl`);
        const tr = await runTrial({
          task,
          trialIndex: i,
          modelLabel: args.model,
          policy,
          session: env.session,
          adminBase: env.adminBase,
          publicBase: env.publicBase,
          mailDir: env.mailDir,
          trajectoryPath,
        });
        results.push(tr);
        process.stdout.write(
          `  ${task.id} #${i}: ${tr.verdict.code} (${tr.steps} steps, ${tr.durationMs}ms)\n`,
        );
      }
    }

    const generatedAt = new Date().toISOString();
    const report = buildPassKReport(
      args.model,
      args.k,
      results.map((r) => ({ taskId: r.taskId, verdict: r.verdict.code })),
      generatedAt,
    );
    const trials: RunTrialRecord[] = results.map((r) => ({
      taskId: r.taskId,
      trialIndex: r.trialIndex,
      verdict: r.verdict.code,
      steps: r.steps,
      durationMs: r.durationMs,
      trajectoryPath: r.trajectoryPath,
    }));
    const artifact: RunArtifact = {
      schema: RUN_SCHEMA,
      model: args.model,
      mode,
      k: args.k,
      generatedAt,
      report,
      trials,
    };
    const path = writeRun("runs", artifact);
    process.stdout.write(
      `\nrun written: ${path}\n` +
        `  model=${args.model} mode=${mode} k=${args.k} tasks=${report.perTask.length}\n` +
        `  pass^${args.k}=${(report.passK * 100).toFixed(1)}%  per-trial=${(report.perTrialPassRate * 100).toFixed(1)}%  ` +
        `95%LB=${(report.perTrialLowerBound95 * 100).toFixed(1)}%  silentCorruptions=${report.silentCorruptions}\n`,
    );
    if (mode === "stub") {
      process.stdout.write(
        "  (stub replay: this measures harness + sim determinism, not model capability)\n",
      );
    }
  } finally {
    await env.stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
