/**
 * Bring-your-own-results import adapter.
 *
 * Turns a CUA framework's own trial results (Browser Use, Skyvern, anything)
 * into Maudslay's pass^k reliability report — WITHOUT the two-witness gate.
 *
 * Honest by construction: self-reported success/failure cannot witness a silent
 * corruption (a wrong record the framework believed it wrote correctly), so this
 * adapter NEVER emits a corruption verdict and NEVER writes a `runs/` artifact.
 * It is a reporter, not a gate. The path to real gating is wiring the two
 * witnesses (see docs/ADOPTING.md). Provenance travels with the output:
 * `source: "self-reported"`, `outcomeVerified: false`.
 */

import { buildPassKReport } from "../../harness/passk.ts";
import type { PassKReport, VerdictCode } from "../../src/types.ts";

export const EXTERNAL_RESULTS_SCHEMA = "maudslay.external-results/1";
export const IMPORT_REPORT_SCHEMA = "maudslay.import-report/1";

/** The documented, Maudslay-owned import shape. NOT a framework's native format. */
export interface ExternalResults {
  schema: string;
  model: string;
  k: number;
  trials: Array<{ taskId: string; trialIndex: number; outcome: "success" | "failure" }>;
}

export interface ImportReport {
  schema: string;
  source: "self-reported";
  outcomeVerified: false;
  report: PassKReport;
}

/** Thrown for every malformed input — fail closed, never a partial report. */
export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

const TOP_KEYS = new Set(["schema", "model", "k", "trials"]);
const TRIAL_KEYS = new Set(["taskId", "trialIndex", "outcome"]);

function rejectUnknownKeys(obj: object, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ImportValidationError(
        `${where}: unknown key "${key}" — a typo'd field must not silently drop; failing closed`,
      );
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + validate external results into the flat verdict list and the derived
 * pass^k report. Fail-closed: any malformed input throws ImportValidationError
 * with a named, greppable message. success → OK, failure → MISSING (never a
 * corruption code — self-report cannot witness one, so pass^k stays honest).
 */
export function adapt(
  raw: unknown,
  generatedAt: string,
): { report: PassKReport; flat: Array<{ taskId: string; verdict: VerdictCode }> } {
  if (!isPlainObject(raw)) {
    throw new ImportValidationError("external results must be a JSON object; failing closed");
  }
  rejectUnknownKeys(raw, TOP_KEYS, "external results");

  if (raw.schema !== EXTERNAL_RESULTS_SCHEMA) {
    throw new ImportValidationError(
      `schema must be "${EXTERNAL_RESULTS_SCHEMA}" but got ${JSON.stringify(raw.schema)}; failing closed`,
    );
  }
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    throw new ImportValidationError("model must be a non-empty string; failing closed");
  }
  if (typeof raw.k !== "number" || !Number.isInteger(raw.k) || raw.k < 1) {
    throw new ImportValidationError(`k must be an integer >= 1 but got ${JSON.stringify(raw.k)}; failing closed`);
  }
  if (!Array.isArray(raw.trials) || raw.trials.length === 0) {
    throw new ImportValidationError("trials must be a non-empty array; failing closed");
  }

  const seen = new Set<string>();
  const perTaskCount = new Map<string, number>();
  const flat: Array<{ taskId: string; verdict: VerdictCode }> = [];

  raw.trials.forEach((t, i) => {
    if (!isPlainObject(t)) {
      throw new ImportValidationError(`trials[${i}] must be an object; failing closed`);
    }
    rejectUnknownKeys(t, TRIAL_KEYS, `trials[${i}]`);
    if (typeof t.taskId !== "string" || t.taskId.length === 0) {
      throw new ImportValidationError(`trials[${i}].taskId must be a non-empty string; failing closed`);
    }
    if (typeof t.trialIndex !== "number" || !Number.isInteger(t.trialIndex) || t.trialIndex < 0) {
      throw new ImportValidationError(
        `trials[${i}].trialIndex must be an integer >= 0 but got ${JSON.stringify(t.trialIndex)}; failing closed`,
      );
    }
    if (t.outcome !== "success" && t.outcome !== "failure") {
      throw new ImportValidationError(
        `trials[${i}].outcome must be "success" or "failure" but got ${JSON.stringify(t.outcome)}; failing closed`,
      );
    }
    const key = `${t.taskId}@${t.trialIndex}`;
    if (seen.has(key)) {
      throw new ImportValidationError(
        `duplicate trial ${key} — a padded/duplicated record cannot stand in for a real one; failing closed`,
      );
    }
    seen.add(key);
    perTaskCount.set(t.taskId, (perTaskCount.get(t.taskId) ?? 0) + 1);
    flat.push({ taskId: t.taskId, verdict: t.outcome === "success" ? "OK" : "MISSING" });
  });

  // Ragged data that cannot support pass^k at the declared k fails closed —
  // the same rule the gate applies to its own artifacts.
  for (const [taskId, count] of perTaskCount) {
    if (count < raw.k) {
      throw new ImportValidationError(
        `task "${taskId}" has ${count} trial(s) but k=${raw.k} — cannot compute pass^${raw.k}; failing closed`,
      );
    }
  }

  const report = buildPassKReport(raw.model, raw.k, flat, generatedAt);
  return { report, flat };
}

/** Wrap a report with loud, travelling provenance. */
export function toImportReport(report: PassKReport): ImportReport {
  return { schema: IMPORT_REPORT_SCHEMA, source: "self-reported", outcomeVerified: false, report };
}

/** The banner every human-facing surface must show — honesty is not optional. */
export const PROVENANCE_BANNER =
  "SELF-REPORTED — pass^k math over your own results, NOT two-witness outcome verification. " +
  "0 silent corruptions here is structural (self-report cannot witness one), not measured. " +
  "To gate for real, wire the two witnesses (docs/ADOPTING.md).";
