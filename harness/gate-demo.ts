/**
 * `npm run gate:demo` — watch the gate block.
 *
 * Runs the real gate over a DELIBERATELY REGRESSED fixture (demo/): a
 * fictional "demo-agent" whose latest run carries a floor miss AND one silent
 * corruption. This is a demonstration of the blocking behavior, not a
 * live-model measurement — the banner says so on every run.
 *
 * Semantics are inverted on purpose: the demo SUCCEEDS (exit 0) when the gate
 * correctly FAILS the fixture, and fails (exit 1) if the fixture ever rots
 * into passing. A regression lock in tests/gate-demo.test.ts pins the same.
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runGate } from "./gate.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function runDemo(): { blocked: boolean; failures: string[] } {
  const { report } = runGate(join(root, "demo", "runs"), join(root, "demo", "ratchet.json"));
  return {
    blocked: !report.outcome.pass,
    failures: report.outcome.pass ? [] : report.outcome.failures,
  };
}

function main(): void {
  console.log(
    "DEMONSTRATION — a deliberately regressed fixture (demo/), not a live-model result.\n" +
      "The point is to watch the merge gate refuse:\n",
  );
  const { blocked, failures } = runDemo();
  if (blocked) {
    console.log("GATE FAIL (as it must — this fixture regressed)");
    for (const f of failures) console.log(`  - ${f}`);
    console.log(
      "\nDEMO OK: the gate blocked the regressed run. In CI this exit code is what\n" +
        "stops the merge. Run `npm run gate` for the real repository gate.",
    );
    process.exit(0);
  }
  console.error("DEMO BROKEN: the regressed fixture PASSED the gate — fix demo/ before shipping.");
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
