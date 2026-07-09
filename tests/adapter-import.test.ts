import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adapt,
  toImportReport,
  ImportValidationError,
  EXTERNAL_RESULTS_SCHEMA,
} from "../examples/import/adapt.ts";
import { buildPassKReport } from "../harness/passk.ts";

const AT = "2026-07-08T00:00:00.000Z";
const sample = () =>
  JSON.parse(readFileSync(join("tests", "fixtures", "external-results-sample.json"), "utf8"));

test("import: maps a valid file to a pass^k report (success→OK, failure→MISSING)", () => {
  const { report, flat } = adapt(sample(), AT);
  // refund-flow has one failure → not all-k → passK = 1/2.
  assert.equal(report.passK, 0.5);
  assert.deepEqual(
    flat.map((t) => t.verdict),
    ["OK", "OK", "OK", "MISSING"],
  );
});

test("import: derived report is identical to the passk builder over the same trials", () => {
  const { report, flat } = adapt(sample(), AT);
  const direct = buildPassKReport("my-browser-use-agent", 2, flat, AT);
  assert.deepEqual(report, direct, "the adapter must reuse the single report authority, not re-derive");
});

test("import: self-reported data structurally carries zero silent corruptions", () => {
  const { report } = adapt(sample(), AT);
  assert.equal(report.silentCorruptions, 0);
});

test("import: provenance is loud — source self-reported, outcomeVerified false", () => {
  const { report } = adapt(sample(), AT);
  const wrapped = toImportReport(report);
  assert.equal(wrapped.source, "self-reported");
  assert.equal(wrapped.outcomeVerified, false);
});

test("import: trial order does not change the aggregate numbers (exactly-k)", () => {
  // With exactly-k enforced, slice(0,k) covers every trial, so the headline
  // aggregates are order-invariant. (perTask is first-seen order, which may
  // differ; the numbers that matter must not.)
  const forward = adapt(sample(), AT).report;
  const s = sample();
  s.trials.reverse();
  const reversed = adapt(s, AT).report;
  assert.equal(reversed.passK, forward.passK);
  assert.equal(reversed.perTrialPassRate, forward.perTrialPassRate);
  assert.equal(reversed.perTrialLowerBound95, forward.perTrialLowerBound95);
  assert.equal(reversed.silentCorruptions, forward.silentCorruptions);
});

const bad: Array<[string, (s: ReturnType<typeof sample>) => void]> = [
  ["duplicate trialIndex", (s) => (s.trials[1].trialIndex = 0)],
  ["missing taskId", (s) => delete s.trials[0].taskId],
  ["bad outcome", (s) => (s.trials[0].outcome = "maybe")],
  ["unknown top-level key", (s) => (s.extra = 1)],
  ["unknown trial key", (s) => (s.trials[0].note = "x")],
  ["empty trials", (s) => (s.trials = [])],
  ["wrong schema", (s) => (s.schema = "something-else")],
  ["k below 1", (s) => (s.k = 0)],
  ["ragged task below k", (s) => s.trials.push({ taskId: "lonely", trialIndex: 0, outcome: "success" })],
];

for (const [name, mutate] of bad) {
  test(`import: ${name} fails closed with a named error`, () => {
    const s = sample();
    mutate(s);
    assert.throws(() => adapt(s, AT), ImportValidationError, `${name} must throw ImportValidationError`);
  });
}

test("import: a task with MORE than k trials fails closed (order-gameable otherwise)", () => {
  // Without exactly-k, buildPassKReport grades slice(0,k) in file order, so
  // moving a failure past position k would flip the task to PASS. Reject it.
  const s = sample();
  s.trials.push({ taskId: "checkout-flow", trialIndex: 2, outcome: "failure" });
  assert.throws(() => adapt(s, AT), ImportValidationError, "count > k must fail closed, not grade file order");
});

test("import: schema constant is the documented external-results id", () => {
  assert.equal(EXTERNAL_RESULTS_SCHEMA, "maudslay.external-results/1");
});

// --- CLI safety: a self-reported report must never be writable into runs/ ----
import { assertSafeOutPath, parseArgs } from "../examples/import/cli.ts";

test("import CLI: --out inside runs/ is refused", () => {
  assert.throws(() => assertSafeOutPath("runs/import.json"), ImportValidationError);
  assert.throws(() => assertSafeOutPath("./runs/x/import.json"), ImportValidationError);
});

test("import CLI: --out outside runs/ is accepted", () => {
  assert.ok(assertSafeOutPath("var/import-report.json").endsWith("import-report.json"));
});

test("import CLI: parseArgs reads input + --out", () => {
  const a = parseArgs(["results.json", "--out", "var/x.json"]);
  assert.equal(a.input, "results.json");
  assert.equal(a.out, "var/x.json");
});

// --- CLI symlink hardening: a symlinked parent into runs/ is still refused ----
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("import CLI: a symlinked ancestor pointing into runs/ is refused", () => {
  const base = mkdtempSync(join(tmpdir(), "maudslay-symlink-"));
  try {
    mkdirSync(join(base, "runs", "inner"), { recursive: true });
    symlinkSync(join(base, "runs", "inner"), join(base, "link")); // link -> .../runs/inner
    assert.throws(
      () => assertSafeOutPath(join(base, "link", "report.json")),
      ImportValidationError,
      "a symlinked ancestor into runs/ must be caught by the realpath check",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
