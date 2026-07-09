import { test } from "node:test";
import assert from "node:assert/strict";
import { runDemo } from "../harness/gate-demo.ts";
import { checkThreshold } from "../examples/import/check.ts";
import { ImportValidationError } from "../examples/import/adapt.ts";

test("gate:demo — the regressed fixture is BLOCKED, with both failure classes", () => {
  const { blocked, failures } = runDemo();
  assert.equal(blocked, true, "the demo fixture must never rot into passing");
  assert.ok(
    failures.some((f) => /silent corruption/i.test(f)),
    `demo must show the hard invariant firing; got ${JSON.stringify(failures)}`,
  );
  assert.ok(
    failures.some((f) => /passK|pass\^|floor|minPassK|below/i.test(f)),
    `demo must show a floor miss; got ${JSON.stringify(failures)}`,
  );
});

test("action threshold check — meets, misses, and fails closed", () => {
  const report = {
    schema: "maudslay.import-report/1",
    source: "self-reported",
    outcomeVerified: false,
    report: { passK: 0.5, k: 2 },
  };
  assert.equal(checkThreshold(report, 0.4).ok, true);
  assert.equal(checkThreshold(report, 0.6).ok, false);
  assert.ok(/self-reported/.test(checkThreshold(report, 0.4).detail), "provenance must travel in the verdict");
  assert.throws(() => checkThreshold({ schema: "other" }, 0.5), ImportValidationError);
  assert.throws(() => checkThreshold(report, 1.5), ImportValidationError);
});
