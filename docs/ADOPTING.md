# Adopting Maudslay for your own agent

Two ways in, honest about what each buys you.

## 0. One CI step (the fastest path)

```yaml
- uses: theo-ai-lab/maudslay@main
  with:
    results: path/to/my-results.json   # maudslay.external-results/1
    min-pass-k: "0.8"                  # optional: fail the job below this
```

Outputs `pass-k` and `report-path` for later steps. Same honest scope as the
local reporter below: self-reported provenance, no silent-corruption detection.

## 1. Report on results you already have (5 minutes, no wiring)

If your agent framework (Browser Use, Skyvern, a homegrown harness) already
records per-trial success/failure, you can run Maudslay's pass^k reliability
math over those results today — no witnesses, no sim, no code changes to your
agent.

Write your results as a `maudslay.external-results/1` file:

Every task needs **exactly `k`** trials (fewer cannot compute pass^k; more would
make the result depend on trial order, so it is rejected). This example uses
`k: 2`:

```json
{
  "schema": "maudslay.external-results/1",
  "model": "my-agent-v3",
  "k": 2,
  "trials": [
    { "taskId": "checkout", "trialIndex": 0, "outcome": "success" },
    { "taskId": "checkout", "trialIndex": 1, "outcome": "failure" },
    { "taskId": "refund", "trialIndex": 0, "outcome": "success" },
    { "taskId": "refund", "trialIndex": 1, "outcome": "success" }
  ]
}
```

Then:

```bash
node examples/import/cli.ts my-results.json --out var/import-report.json
```

You get pass^k (all-k-must-pass), the per-trial rate, and the Clopper–Pearson
95% floor — the same math the gate uses — plus fail-closed schema validation
that rejects ragged, duplicated, or malformed data instead of quietly averaging
around it.

**What this is NOT.** This path is a *reporter*, not the two-witness gate. Your
framework's `outcome` is self-reported: it can say "the agent thought it
succeeded," but it cannot witness a *silent corruption* — the agent booking the
wrong record and believing it got it right. So imported reports carry
`source: "self-reported"`, `outcomeVerified: false`, and their silent-corruption
count is structurally zero (nothing measured it), never a green light. The tool
prints this on every run.

### Mapping your framework's output

Converters for the two most common shapes ship in
[`examples/import/from-frameworks.ts`](../examples/import/from-frameworks.ts),
with the derivation rules verified against each project's main branch (2026-07):

- **Browser Use** — `Agent.save_history()` writes `AgentHistory.json`:
  `{"history": [...]}` where each step carries a `result` array. The terminal
  outcome is **derived, not stored**: the last result of the last step counts as
  success only when `is_done: true` *and* `success: true` (the export omits
  `success` on non-terminal actions, and the library's own `is_successful()` is
  tri-state — a run that never finished converts to `"failure"`, never a guess).
  The export carries **no task id**, so `fromBrowserUse()` takes a manifest
  mapping each history file to a `taskId`/`trialIndex`.
- **Skyvern** — a run response has `status` (lowercase; terminal values
  `completed`, `failed`, `terminated`, `canceled`, `timed_out`) and **no success
  boolean**: success is exactly `status === "completed"` (`skyvernOutcome()`).
  A non-terminal status (`running`, `queued`, `created`) fails closed — grading
  a run still in flight would be a guess.
- **Anything else** — you only need `taskId`, `trialIndex`, and
  `success`/`failure`. `trialIndex` must be unique per task, and every task must
  have **exactly `k`** trials (down-select deliberately if your framework ran
  more — the tool will not silently pick which `k` to grade).

## 2. Gate for real (the two-witness path)

To get the thing the reporter can't give you — detection of silent corruption,
and a merge-blocking floor you can trust — the outcome has to be graded by
channels your agent does not author. That means, for your app:

1. An **independent ground-truth channel** per task: a backend row, a
   confirmation email, an API read — something the agent cannot write directly.
   See [`groundtruth/verifier.ts`](../groundtruth/verifier.ts) for how the
   reference sim grades from two witnesses and never reads the screen.
2. **Task expectations** describing the correct outcome (and the ambiguous
   tasks whose only correct outcome is escalation) — see
   [`harness/tasks.ts`](../harness/tasks.ts).
3. A **live run** that produces a `runs/` artifact, and a `ratchet.json` floor.
   From there the gate in [`harness/gate.ts`](../harness/gate.ts) is yours.

This is more work, and it is the work that makes the number mean something.
[`ARCHITECTURE.md`](../ARCHITECTURE.md) maps every piece you would supply.
