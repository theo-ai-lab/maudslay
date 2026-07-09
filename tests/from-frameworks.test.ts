import { test } from "node:test";
import assert from "node:assert/strict";
import { browserUseOutcome, fromBrowserUse, skyvernOutcome } from "../examples/import/from-frameworks.ts";
import { adapt, ImportValidationError } from "../examples/import/adapt.ts";

// Fixtures mirror the VERIFIED export shapes (field names from each project's
// main branch, 2026-07): {"history":[{..., "result":[{"is_done","success"}]}]}
const terminalSuccess = { history: [
  { model_output: {}, result: [{ is_done: false, extracted_content: "clicked" }], state: {}, metadata: null, state_message: null },
  { model_output: {}, result: [{ is_done: true, success: true, extracted_content: "done" }], state: {}, metadata: null, state_message: null },
] };
const terminalFailure = { history: [
  { model_output: {}, result: [{ is_done: true, success: false }], state: {}, metadata: null, state_message: null },
] };
// Non-terminal run: exclude_none means `success` is ABSENT, is_done false.
const neverFinished = { history: [
  { model_output: {}, result: [{ is_done: false, extracted_content: "typed" }], state: {}, metadata: null, state_message: null },
] };

test("browser-use: terminal success/failure derive from the last result of the last step", () => {
  assert.equal(browserUseOutcome(terminalSuccess), "success");
  assert.equal(browserUseOutcome(terminalFailure), "failure");
});

test("browser-use: a never-finished history (success absent, tri-state) is a failure, not a guess", () => {
  assert.equal(browserUseOutcome(neverFinished), "failure");
});

test("browser-use: malformed histories fail closed with the named error", () => {
  for (const bad of [null, [], {}, { history: [] }, { history: [{ result: [] }] }, { history: [{}] }]) {
    assert.throws(() => browserUseOutcome(bad), ImportValidationError);
  }
});

test("browser-use: a manifest converts straight into an adaptable external-results doc", () => {
  const files: Record<string, unknown> = {
    "a0.json": terminalSuccess, "a1.json": terminalSuccess,
    "b0.json": terminalSuccess, "b1.json": terminalFailure,
  };
  const doc = fromBrowserUse(
    { model: "my-browser-use-agent", k: 2, trials: [
      { taskId: "a", trialIndex: 0, historyFile: "a0.json" },
      { taskId: "a", trialIndex: 1, historyFile: "a1.json" },
      { taskId: "b", trialIndex: 0, historyFile: "b0.json" },
      { taskId: "b", trialIndex: 1, historyFile: "b1.json" },
    ] },
    (p) => JSON.stringify(files[p]),
  );
  const { report } = adapt(doc, "2026-07-09T00:00:00.000Z");
  assert.equal(report.passK, 0.5, "one of two tasks passes both trials");
  assert.equal(report.silentCorruptions, 0);
});

test("skyvern: completed is the only success; other terminal statuses are failures", () => {
  assert.equal(skyvernOutcome("completed"), "success");
  for (const s of ["failed", "terminated", "canceled", "timed_out"]) {
    assert.equal(skyvernOutcome(s), "failure", s);
  }
});

test("skyvern: non-terminal or unknown statuses fail closed (grading a running run is a guess)", () => {
  for (const s of ["running", "queued", "created", "cancelled", "COMPLETED", 7, null]) {
    assert.throws(() => skyvernOutcome(s), ImportValidationError, String(s));
  }
});
