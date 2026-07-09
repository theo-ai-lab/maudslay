/**
 * Framework converters: real exported shapes → maudslay.external-results/1.
 *
 * Field names below were verified against each project's main branch
 * (2026-07); the exact derivation rules are cited in docs/ADOPTING.md.
 *
 * Browser Use — `Agent.save_history()` writes `AgentHistory.json`:
 * `{ "history": [step, ...] }` where each step carries a `result` array of
 * ActionResult dicts. The terminal outcome is DERIVED, not stored: the last
 * result of the last step, `is_done === true && success === true` → success
 * (the library's own `is_successful()` is tri-state; `success` is absent for
 * non-terminal actions because results are dumped with exclude_none). The task
 * id is NOT in the export, so the converter takes a manifest mapping files to
 * task/trial identities.
 *
 * Skyvern — a run response carries `status` (lowercase enum; terminal values:
 * completed, failed, terminated, canceled, timed_out) and NO success boolean:
 * success is `status === "completed"`, exactly.
 *
 * Both converters fail closed: an unrecognized shape or a non-terminal record
 * throws, never guesses.
 */

import { readFileSync } from "node:fs";
import { EXTERNAL_RESULTS_SCHEMA, ImportValidationError, type ExternalResults } from "./adapt.ts";

// --- Browser Use -------------------------------------------------------------

/**
 * Derive success/failure from a parsed AgentHistory.json. Mirrors
 * AgentHistoryList.is_done()/is_successful(): last result of last step;
 * tri-state `success` collapses honestly — only an explicit `true` on a
 * terminal (`is_done: true`) result counts as success; a non-terminal history
 * (agent never finished) fails closed as "failure".
 */
export function browserUseOutcome(historyDoc: unknown): "success" | "failure" {
  if (!historyDoc || typeof historyDoc !== "object" || Array.isArray(historyDoc)) {
    throw new ImportValidationError("Browser Use history: top level must be an object; failing closed");
  }
  const h = (historyDoc as { history?: unknown }).history;
  if (!Array.isArray(h) || h.length === 0) {
    throw new ImportValidationError('Browser Use history: missing/empty "history" array; failing closed');
  }
  const last = h[h.length - 1] as { result?: unknown };
  if (!last || typeof last !== "object" || !Array.isArray(last.result) || last.result.length === 0) {
    throw new ImportValidationError('Browser Use history: last step carries no "result" array; failing closed');
  }
  const r = last.result[last.result.length - 1] as { is_done?: unknown; success?: unknown };
  if (!r || typeof r !== "object") {
    throw new ImportValidationError("Browser Use history: last result is not an object; failing closed");
  }
  return r.is_done === true && r.success === true ? "success" : "failure";
}

export interface BrowserUseManifest {
  model: string;
  k: number;
  /** One entry per trial: which history file is which task/trial. */
  trials: Array<{ taskId: string; trialIndex: number; historyFile: string }>;
}

/** Read a manifest + its history files into an external-results document. */
export function fromBrowserUse(
  manifest: BrowserUseManifest,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): ExternalResults {
  if (!Array.isArray(manifest.trials) || manifest.trials.length === 0) {
    throw new ImportValidationError("manifest.trials must be a non-empty array; failing closed");
  }
  return {
    schema: EXTERNAL_RESULTS_SCHEMA,
    model: manifest.model,
    k: manifest.k,
    trials: manifest.trials.map((t) => ({
      taskId: t.taskId,
      trialIndex: t.trialIndex,
      outcome: browserUseOutcome(JSON.parse(readFile(t.historyFile))),
    })),
  };
}

// --- Skyvern ------------------------------------------------------------------

const SKYVERN_TERMINAL = new Set(["completed", "failed", "terminated", "canceled", "timed_out"]);

/**
 * Success is `status === "completed"` — Skyvern has no success boolean. A
 * non-terminal status (created/queued/running) is a run still in flight, and
 * grading it would be a guess: fail closed.
 */
export function skyvernOutcome(status: unknown): "success" | "failure" {
  if (typeof status !== "string" || !SKYVERN_TERMINAL.has(status)) {
    throw new ImportValidationError(
      `Skyvern status ${JSON.stringify(status)} is not a terminal status (${[...SKYVERN_TERMINAL].join(", ")}); failing closed`,
    );
  }
  return status === "completed" ? "success" : "failure";
}
