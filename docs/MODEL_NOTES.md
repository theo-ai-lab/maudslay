# Model notes — the computer-use surface, and what one live run looked like

This document records the model-facing decisions (what is pinned, what is
verified, what is deliberately swappable) and the observed behavior from the
first live run. Config facts are grounded in [`agent/model.ts`](../agent/model.ts)
and [decisions/D4-cua-api-surface.md](decisions/D4-cua-api-surface.md); run
facts come from the committed artifact
[`runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json`](../runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json).

---

## 1. The pinned API surface (D4)

The computer-use request shape is not guessed — it was ground-truthed from
Anthropic's public computer-use documentation in July 2026 and pinned in
[decisions/D4-cua-api-surface.md](decisions/D4-cua-api-surface.md). The exact
strings live as constants in [`agent/model.ts`](../agent/model.ts):

- **Tool type `computer_20251124`** — the current generation of the
  computer-use tool, declared with a fixed `1280×800` display that matches the
  sandbox viewport exactly (`COMPUTER_TOOL`). One display, one viewport, no
  scaling ambiguity between what the model is told and what the executor
  screenshots.
- **Beta header `computer-use-2025-11-24`** — the beta that enables that tool
  type, passed via `betas` on `client.beta.messages.create`
  (`COMPUTER_USE_BETA`).
- **Two custom tools alongside `computer`** — `escalate {reason}` and
  `done {summary}`. Trial termination is a tool call, never a text convention
  parsed out of prose (D4 offered both options; the tool approach was chosen).
- **No `temperature` / `top_p` / `top_k`, no `thinking`.** Effort is carried
  only via `output_config: { effort }`; `ModelConfig`'s `"xhigh"` maps to the
  API's `"max"` (`mapEffort`). Omitting `thinking` everywhere means the
  reconstructed assistant turn never has to preserve thinking blocks — the
  transcript echo in `parseResponse` is lossless by construction.

`buildRequestBody` is pure, so the entire wire shape is unit-tested without a
network call (see `tests/agent.test.ts`).

## 2. Why `claude-fable-5` is flagged UNVERIFIED, and the default is `claude-opus-4-8`

D4's read of the docs' beta note lists the models supported for the
computer-use tool: Sonnet 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6,
Opus 4.5. **Claude Fable 5 is not on that list.** Maudslay's policy follows
from the repo's no-fabrication rule:

- **Default computer-use model = `claude-opus-4-8`** — the top listed model,
  as documented.
- `claude-fable-5` remains a selectable `ModelId`
  ([`src/types.ts`](../src/types.ts)), but the harness **does not assume it
  works**: `AnthropicModel` submits the request as configured and surfaces any
  400 to the caller unmodified. No doc in this repo claims Fable 5 computer-use
  support, because none was verified.
- If Fable 5 is attempted, the D4-prescribed shape applies: `thinking` omitted,
  and — when `fallbackToOpus` is set (the CLI default for Fable 5 only, see
  [`harness/trial-cli.ts`](../harness/trial-cli.ts)) — the
  `server-side-fallback-2026-06-01` beta plus
  `fallbacks: [{ model: "claude-opus-4-8" }]`, with
  `stop_reason === "refusal"` checked before reading content.

This is the same honesty posture as the README's per-model table: a cell is
"pending live run" until an artifact exists, and a model is "unverified" until
the docs or a run say otherwise.

## 3. Model-configurable by design (the compounding property)

The model id is data, not architecture. `ModelConfig`
([`src/types.ts`](../src/types.ts)) carries `{ model, effort, fallbackToOpus,
maxTokensPerTurn }`; swapping `claude-opus-4-8` for any other id changes
nothing else — the sim, the sandbox, the two-witness verifier, the pass^k math,
and the gate are all model-agnostic. Concretely:

- [`ratchet.json`](../ratchet.json) keeps **per-model** floors, so each model
  ratchets against its own measured history.
- [`harness/report.ts`](../harness/report.ts) renders the per-model table
  straight from `runs/` artifacts — adding a model to the table means running
  it, not editing markdown.
- The stub/oracle policies share the same trial plumbing, so the key-free CI
  path exercises the identical harness the live models run through.

This is the churn-survival argument: computer-use model generations turn over
quickly (the D4 support list alone spans six models across two families). A
gate whose only model coupling is one id string and one pinned request shape
survives that churn — each new model is a re-run, and the measured history
compounds instead of resetting.

## 4. Observed behavior — the k=5 live run against `claude-opus-4-8`

One run, 2026-07-05. Configuration: `claude-opus-4-8`, tool type
`computer_20251124`, beta `computer-use-2025-11-24`, `effort: high`,
`max_tokens` 4096/turn, prompt caching on (two ephemeral breakpoints: the
system+tools prefix and the last message block — see `applyCacheControl` in
[`agent/model.ts`](../agent/model.ts)). 12 tasks × 5 trials = 60 trials.

**Results (from the artifact, not retyped estimates):**

| Metric | Value |
|---|---|
| pass^5 | **100%** (all 5 trials succeeded on all 12 tasks) |
| per-trial pass rate | 100% (60/60) |
| Clopper–Pearson 95% lower bound (per-trial) | **94.0%** |
| silent corruptions (`WRONG_RECORD` / `ACTED_ON_MUST_ESCALATE`) | **0** |
| escalation rate | 33.3% |

The escalation rate is exactly the suite composition: 4 of the 12 tasks are
`must_escalate` traps ([`harness/tasks.ts`](../harness/tasks.ts)), so 4 × 5 =
20 of 60 trials correctly ended `ESCALATED_OK`, and 20/60 = 33.3%. The model
escalated on every trap trial and never escalated a fulfillable task.

### Step counts by task type

Observed ranges across the 60 trials (a "step" is one recorded action through
the executor):

| Task type | Steps observed |
|---|---|
| bookings | 17–32 |
| cancel | 4 |
| reschedule | 8–32 |
| `must_escalate` traps | 2–32 |

Cancel was the tightest surface in the sim (find the booking, cancel, confirm),
and the model took the same 4 steps every trial. Booking creation is the
longest form-fill path, and conflict-recovery variants sit at the top of the
range.

### The escalation-latency finding

The most interesting behavioral observation is *how long the model took to
decide to escalate*, and it split cleanly by trap type:

- **`escalate-pastdate-001`** (requested date is in the past): often escalated
  in **~2 steps** — the model recognized the request as invalid from the
  instruction plus the first screen, without exploring the UI.
- **`escalate-overbook-001`** (exact time pinned, slot taken, no fallback) and
  **`escalate-nomatch-001`** (customer not in the system): often **17–32
  steps** — the model worked the UI first (searched the customer, walked the
  schedule, attempted the path it was asked for) and escalated only after the
  screens confirmed the request could not be fulfilled.

Read plainly: when the *instruction itself* carries the contradiction, this
model refuses immediately; when the contradiction only exists *in the
application state*, it verifies before refusing. For a dispatcher workflow that
is arguably the right ordering — the expensive exploration happens exactly on
the traps where the evidence lives behind the UI. But that is an
interpretation; what is measured is the step-count split above.

**These are observations from one run (n = 5 trials per task, one model, one
suite), not universal claims about the model.** Whether the latency split holds
across re-runs, other models, or reworded instructions is not measured.

### Cost and caching (measured)

The run made 1,024 billed API calls. Token totals: 2,048 uncached input,
1,296,299 cache-write, 16,878,499 cache-read, 122,681 output.

- **Actual cost: $19.62** (Opus 4.8 pricing $5/$25 per Mtok in/out, cache-write
  at 1.25×, cache-read at 0.1×).
- Without caching the same run would have cost **~$93.95** — caching saved
  ~$74, i.e. ~79%. This is why `applyCacheControl` exists: the screenshot
  history grows every turn and is never pruned, so uncached input cost is
  quadratic in trial length; the cache-read/cache-write ratio above (~13:1)
  shows the prefix cache doing exactly that work.
- Derived unit costs: **~$0.33 per trial** ($19.62 / 60) and **~$1.64 per full
  5-trial task verification** ($19.62 / 12).

### Not measured

- `claude-sonnet-4-6` and `claude-fable-5` pass^k: not measured (pending live
  runs; Fable 5 additionally unverified for the computer-use tool per D4).
- Wall-clock latency per turn / per trial distribution: not measured here (the
  artifact records per-trial durations, but no latency claim is made in this
  document).
- Stability of the escalation-latency split across runs, models, or prompt
  variants: not measured.

---

Behavioral summaries here never substitute for the gate. The gate reads the
artifact ([`harness/gate.ts`](../harness/gate.ts)), enforces the ratchet
floors, and fails on any nonzero silent-corruption count regardless of pass^k —
see [../README.md](../README.md) and [VERIFICATION.md](VERIFICATION.md).
