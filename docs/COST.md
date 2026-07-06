# Cost — FinOps for the k=5 live gate run

What one full gate decision costs, where every dollar went, and why the unit
that matters is **cost per verified outcome**, not cost per token.

All numbers below come from one source: the per-request usage ledger the run
wrote via `MAUDSLAY_USAGE_LOG` (see [The ledger](#the-ledger-maudslay_usage_log)).
Nothing here is estimated except the explicitly-labelled uncached
counterfactual, whose arithmetic is shown. Anything not in that ledger is
marked **not measured**.

## The run

The k=5 live run against `claude-opus-4-8` (artifact:
[`runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json`](../runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json)):
computer-use tool type `computer_20251124`, beta `computer-use-2025-11-24`,
`effort=high`, `max_tokens` 4096/turn, prompt caching on (two ephemeral
breakpoints: the system+tools prefix and the last message block — see
[`agent/model.ts`](../agent/model.ts) `applyCacheControl`).

12 tasks × 5 trials = 60 trials. All 60 passed: **pass^5 = 100%**, per-trial
pass rate 100% (60/60), Clopper–Pearson 95% lower bound 94.0%, silent
corruptions 0, escalation rate 33.3% (4 of 12 tasks are `must_escalate`, so 20
of 60 trials correctly ended `ESCALATED_OK`).

## Headline numbers

| Metric | Value |
|---|---|
| Billed API calls | 1,024 |
| Uncached input tokens | 2,048 |
| Cache-write tokens | 1,296,299 |
| Cache-read tokens | 16,878,499 |
| Output tokens | 122,681 |
| **Actual cost** | **$19.62** |
| Uncached counterfactual | ~$93.95 |
| Caching saving | ~$74 (~79%) |
| Cost per trial | ~$0.33 ($19.62 / 60) |
| **Cost per verified task (full 5-trial verification)** | **~$1.64** ($19.62 / 12) |

$19.62 buys the entire gate decision: 12 tasks, each independently verified 5
times against both ground-truth witnesses, with a zero-silent-corruption check.

## The arithmetic (Opus 4.8 rates: $5 in / $25 out per Mtok; cache-write 1.25×, cache-read 0.1×)

Actual cost, from the ledger's token totals:

| Component | Tokens | Rate ($/Mtok) | Cost | Share |
|---|---:|---:|---:|---:|
| Uncached input | 2,048 | 5.00 | $0.01 | ~0% |
| Cache write | 1,296,299 | 6.25 (5 × 1.25) | $8.10 | 41% |
| Cache read | 16,878,499 | 0.50 (5 × 0.1) | $8.44 | 43% |
| Output | 122,681 | 25.00 | $3.07 | 16% |
| **Total** | | | **$19.62** | 100% |

Uncached counterfactual — the same 60 trials with every input token at full
price:

- Total input = 2,048 + 1,296,299 + 16,878,499 = 18,176,846 tokens × $5/Mtok = $90.88
- Output unchanged: $3.07
- **Counterfactual total ≈ $93.95** → saving ≈ $93.95 − $19.62 = **$74.33 (79.1%)**

Derived cache signature (from the totals above):

- Uncached input averaged 2,048 / 1,024 = **2 tokens per billed call** —
  effectively the entire prompt hit cache on every call.
- Read-to-write ratio: 16,878,499 / 1,296,299 ≈ **13×** — each cached token was
  re-read about 13 times over the turns that followed its write.
- Blended input price actually paid: ($19.62 − $3.07) / 18.18 Mtok ≈
  **$0.91/Mtok**, i.e. ~18% of the $5 list rate.

## Why cost per VERIFIED outcome is the metric

A release gate does not sell tokens; it sells a **merge decision backed by
verified end states**. Three reasons the denominator must be the verified
outcome:

1. **Token counts are an implementation detail of the trajectory.** Observed
   step counts in this run spanned 4 (cancel) to 32 (bookings ran 17–32,
   reschedules 8–32) — an 8× spread across tasks that all produce exactly one
   verified verdict. Per-token or per-call comparisons across tasks, models, or
   effort settings compare noise; per-verified-task compares the thing you
   ship.
2. **Correct refusal is not free — and must not be penalized.** The
   `must_escalate` traps ranged from 2 steps (past-date was often recognized
   and escalated immediately) to 32 steps (overbook and unknown-customer often
   took 17–32 steps of UI exploration before concluding escalation). An
   `ESCALATED_OK` can cost as much as a completed booking. A per-token metric
   makes the safest behavior look like the most wasteful; per-verified-outcome
   prices "explored, then correctly declined" as what it is — a passed trial.
3. **It is the number a team can budget against.** ~$1.64 verifies one task at
   k=5; $19.62 runs the full 12-task gate. That is the unit that decides
   whether the gate runs on every merge (the CI-evals recipe the
   [README](../README.md#why-this-exists-the-motivating-literature) is built
   on) or only on releases. The README's per-model table carries a
   `$ / verified task` column for exactly this reason — it is the cross-model
   comparison unit that survives model churn.

## How the two-breakpoint cache design produces the saving

The agent loop keeps the **full screenshot history** — the transcript in
[`agent/model.ts`](../agent/model.ts) is append-only and never pruned, so turn
*N*'s request is turn *N−1*'s request plus one assistant turn and one new
tool-result block. Without caching that makes input cost **quadratic in trial
length**: every earlier screenshot is re-billed at full price on every turn.
At 1,024 calls averaging ~17,751 input tokens each (18,176,846 / 1,024), that
is the $90.88 counterfactual above.

`applyCacheControl` (bottom of [`agent/model.ts`](../agent/model.ts)) converts
that structure from a liability into the saving, with two ephemeral breakpoints
per request:

1. **System+tools prefix** — a `cache_control` marker on the system block
   caches the fixed prefix (tool definitions + system prompt), so every
   subsequent call reads it at 0.1× instead of re-billing it at full price.
2. **Last message block** — a marker on the final content block of the last
   message. Because the transcript only ever grows, the block marked on turn
   *N−1* is an interior prefix of turn *N*'s request: everything up to it is a
   cache **read** (0.1×), and only the new suffix (one assistant turn + one
   tool result, usually a single screenshot) is a cache **write** (1.25×).

So each input token is paid ~once at 1.25× when it first appears and 0.1×
thereafter — the measured 13× read/write ratio and the 2-uncached-tokens-per-call
figure are this design working as intended. Two implementation details matter
for the bill:

- The transform happens **at the wire boundary and never mutates stored
  messages**, so markers do not accumulate across turns — every request carries
  exactly two breakpoints, and the model's outputs are unchanged. This is a
  pure billing transformation; it cannot affect pass^k.
- It composes with never-pruning rather than fighting it: pruning history would
  save tokens but discard the evidence trail the trajectory recorder and the
  model's own context rely on. Caching keeps the full history at ~18% of list
  input price instead.

## The ledger: `MAUDSLAY_USAGE_LOG`

Cost accounting is opt-in and exact, not estimated. When the env var
`MAUDSLAY_USAGE_LOG` is set to a file path, `AnthropicModel.send` in
[`agent/model.ts`](../agent/model.ts) appends **one JSON line per billed API
call**:

```json
{"model":"claude-opus-4-8","input_tokens":...,"output_tokens":...,"cache_creation_input_tokens":...,"cache_read_input_tokens":...}
```

Usage:

```bash
MAUDSLAY_USAGE_LOG=var/usage.jsonl npm run trials -- --model claude-opus-4-8 --k 5
```

It is gated on the env var so offline tests never touch the filesystem, and it
writes under `var/` (gitignored runtime artifacts). Every token total in this
document is a column sum over the 1,024 lines that file contained after the
run; the dollar figures apply the published rates to those sums — there is no
sampling and no estimation step.

Honest limits of the ledger as it stands:

- Lines carry the model id and the four usage counters, **no task or trial
  tag** — so per-task cost attribution is **not measured**. (Line order
  correlates with trial order, but the log does not guarantee that mapping, so
  no per-task split is claimed.)
- The join into the README's `$ / verified task` column is computed from this
  ledger; [`harness/report.ts`](../harness/report.ts) renders its verdict
  columns from `runs/` artifacts and does not yet read the usage log itself.

## Not measured

- Costs for `claude-sonnet-4-6` and `claude-fable-5`: not measured (no live
  run; the same ledger produces them when one happens).
- Cost at other `effort` settings: not measured (this run was `effort=high`
  only).
- Per-task cost breakdown: not measured (see ledger limits above).
- Aggregate wall-clock time: not quoted here (per-trial `durationMs` is
  recorded in the run artifact; no aggregate is computed in this document).
- Batch/off-peak pricing paths: not measured.
