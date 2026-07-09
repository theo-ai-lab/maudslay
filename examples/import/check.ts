/**
 * Threshold check over a self-reported import report — the blocking half of
 * the GitHub Action. Honest by construction: this gates on YOUR framework's
 * own success/failure claims (pass^k math over self-reported data), which is a
 * regression tripwire, NOT two-witness outcome verification. The output says
 * so every time.
 *
 *   node examples/import/check.ts var/import-report.json --min-pass-k 0.8
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { IMPORT_REPORT_SCHEMA, ImportValidationError, type ImportReport } from "./adapt.ts";

/** Pure verdict: does the report meet the threshold? Fail closed on malformed input. */
export function checkThreshold(
  raw: unknown,
  minPassK: number,
): { ok: boolean; passK: number; detail: string } {
  if (!Number.isFinite(minPassK) || minPassK < 0 || minPassK > 1) {
    throw new ImportValidationError(`min-pass-k must be in [0, 1]; got ${String(minPassK)}`);
  }
  const r = raw as Partial<ImportReport> | null;
  if (
    !r || typeof r !== "object" || r.schema !== IMPORT_REPORT_SCHEMA ||
    r.source !== "self-reported" || r.outcomeVerified !== false ||
    !r.report || typeof r.report.passK !== "number" ||
    !Number.isFinite(r.report.passK) || r.report.passK < 0 || r.report.passK > 1
  ) {
    throw new ImportValidationError(
      "input is not a maudslay.import-report/1 (self-reported, outcomeVerified:false) with passK in [0,1] — failing closed",
    );
  }
  const passK = r.report.passK;
  const ok = passK >= minPassK;
  return {
    ok,
    passK,
    detail:
      `self-reported pass^${r.report.k} = ${(passK * 100).toFixed(1)}% vs threshold ${(minPassK * 100).toFixed(1)}% — ` +
      (ok ? "meets it" : "below it") +
      " (regression tripwire over self-reported results, not two-witness verification)",
  };
}

function main(): void {
  const args = process.argv.slice(2);
  // Flag-aware: the token after --min-pass-k is its VALUE, never the file.
  const file = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--min-pass-k");
  const idx = args.indexOf("--min-pass-k");
  const min = idx >= 0 ? Number(args[idx + 1]) : NaN;
  if (!file || !Number.isFinite(min)) {
    console.error("usage: node examples/import/check.ts <import-report.json> --min-pass-k <0..1>");
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(
      new ImportValidationError(
        `cannot read/parse ${file} — failing closed: ${e instanceof Error ? e.message : String(e)}`,
      ).message,
    );
    process.exit(1);
  }
  const verdict = checkThreshold(parsed, min);
  console.log(verdict.detail);
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
