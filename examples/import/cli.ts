/**
 * `import` CLI — run Maudslay's pass^k math over your own framework results.
 *
 *   node examples/import/cli.ts <external-results.json> [--out var/import-report.json]
 *
 * Prints the pass^k report with a loud self-reported provenance banner and
 * writes an import-report JSON to --out. It refuses to write into `runs/`: that
 * directory is for two-witness gate artifacts only, and a self-reported report
 * must never be mistaken for one.
 */

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { adapt, toImportReport, PROVENANCE_BANNER, ImportValidationError } from "./adapt.ts";

const USAGE =
  "usage: node examples/import/cli.ts <external-results.json> [--out <path>]\n" +
  "  Reads a maudslay.external-results/1 file, prints the pass^k report, and\n" +
  "  writes a self-reported import-report to --out (default var/import-report.json).\n" +
  "  This is a REPORTER, not the two-witness gate — see docs/ADOPTING.md.";

/** Refuse any --out that lands inside a runs/ directory — checked both
 * lexically and, to defeat a symlinked ancestor, against the realpath of the
 * nearest existing ancestor directory. */
export function assertSafeOutPath(out: string): string {
  const abs = resolve(out);
  const reject = (p: string) => {
    if (p.split(sep).includes("runs")) {
      throw new ImportValidationError(
        `--out ${out} resolves inside a runs/ directory — self-reported reports must never sit with ` +
          `two-witness gate artifacts; choose a path outside runs/`,
      );
    }
  };
  reject(abs);
  // Walk up to the first ancestor that exists on disk and resolve its symlinks;
  // a symlinked parent pointing into runs/ would slip past the lexical check.
  let dir = dirname(abs);
  for (;;) {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      // This ancestor does not exist yet — keep walking up. (Only realpathSync
      // throws here; reject() runs OUTSIDE the try so its rejection propagates.)
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      continue;
    }
    reject(real);
    break;
  }
  return abs;
}

export function parseArgs(argv: string[]): { input: string; out: string } {
  let input: string | undefined;
  let out = "var/import-report.json";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i] ?? out;
    else if (a?.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return { input: "", out };
    } else if (!a?.startsWith("-")) input = a;
  }
  if (!input) {
    console.error(USAGE);
    throw new ImportValidationError("no input file given");
  }
  return { input, out };
}

function main(): void {
  const { input, out } = parseArgs(process.argv.slice(2));
  if (!input) return; // --help path already printed usage
  const safeOut = assertSafeOutPath(out);
  const raw: unknown = JSON.parse(readFileSync(input, "utf8"));
  const { report } = adapt(raw, new Date().toISOString());
  const wrapped = toImportReport(report);

  console.log(`\n${PROVENANCE_BANNER}\n`);
  console.log(`model:            ${report.model}`);
  console.log(`k:                ${report.k}`);
  console.log(`tasks:            ${report.perTask.length}`);
  console.log(`pass^${report.k}:            ${(report.passK * 100).toFixed(1)}%`);
  console.log(`per-trial rate:   ${(report.perTrialPassRate * 100).toFixed(1)}%`);
  console.log(`95% floor:        ${(report.perTrialLowerBound95 * 100).toFixed(1)}%`);
  console.log(`silent corrupt.:  ${report.silentCorruptions} (structural — self-report cannot witness one)`);

  mkdirSync(dirname(safeOut), { recursive: true });
  writeFileSync(safeOut, JSON.stringify(wrapped, null, 2));
  console.log(`\nwrote ${safeOut}`);
}

// Run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(`import failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
