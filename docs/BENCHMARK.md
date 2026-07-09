# Benchmark methodology

How Maudslay measures a computer-use agent, and why each choice is the rigorous
one. The measurement stack has four load-bearing parts:

1. **pass^k** as the headline metric — all k trials must succeed, per task.
2. A **Clopper–Pearson 95% lower bound** as the only per-trial number worth
   quoting — the floor the data actually supports, not the point estimate.
3. **Two-witness outcome grading** — the confirmation email and the backend
   row, never a screen-scrape.
4. A **silent-corruption hard-fail invariant** that overrides pass^k entirely.

Each is implemented in a pure, unit-tested function, and the k=5 live run
against `claude-opus-4-8` is worked through at the end as the concrete example.
Every number below is either read from the committed run artifact
([`runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json`](../runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json))
or derived from it with the derivation shown.

---

## 1. The metric: pass^k

pass^k is the fraction of **tasks** for which **all k independent trials
succeeded**. This is Anthropic's recommended consistency metric for agents
([Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)):
grade whether every one of k runs got it right, not the average.

The distinction matters because a dispatcher workflow is consistency-critical:
a booking agent that is *usually* right is an agent that sometimes writes the
wrong record. Averages hide exactly that. The arithmetic is unforgiving — an
agent with a true per-trial success rate of 0.9 passes all 5 trials of a task
only 0.9⁵ ≈ 59% of the time. pass^k surfaces flakiness that a per-trial average
launders away; a single flaky failure sinks the whole task, and that is the
point.

Implementation ([`harness/passk.ts`](../harness/passk.ts)):

- `taskPassesK(trials, k)` — a task passes^k iff it has at least k trials and
  the **first k all succeed**.
- `passK(perTask, k)` — the fraction of tasks that pass^k.
- "Success" is defined once, in [`src/types.ts`](../src/types.ts)
  (`isSuccess`): a trial succeeds iff its verdict is `OK` **or**
  `ESCALATED_OK`. Correctly refusing a trap task is a success; it is not
  graded on a curve.

Everything in `passk.ts` is a pure function of already-collected verdicts — no
browser, sim, or network — so it is unit-tested against known values in
[`tests/harness.test.ts`](../tests/harness.test.ts) (closed-form endpoints,
interval containment, and conservatism — the floor always sits below the point
estimate).

## 2. The floor: why we quote a Clopper–Pearson lower bound, not the point estimate

A run where every trial passes has a per-trial point estimate of 100%. Quoting
that as "the agent is ~100% reliable" would be dishonest: 60 trials simply
cannot distinguish a 100%-reliable agent from a 95%-reliable one that got a
mildly lucky hour. The honest number is the **lower confidence limit** — the
worst true rate the observed data are still consistent with.

Two specific choices:

- **Exact (Clopper–Pearson), not a normal approximation.** The textbook Wald
  interval `p̂ ± 1.96·√(p̂(1−p̂)/n)` collapses to zero width at p̂ = 1 — it
  would report "100% ± 0%", which is nonsense. The small-n, near-1 regime is
  exactly where agent evals live, so
  [`harness/passk.ts`](../harness/passk.ts) computes the exact binomial
  interval via the regularized incomplete beta function: the lower limit for
  s successes in n trials is the (α/2) quantile of Beta(s, n−s+1).
- **Lower bound only as the headline.** The upper bound is implemented
  (`clopperPearsonUpper`) for interval sanity checks, but the number the gate
  and the README quote is the floor.

For the all-pass case (s = n) the bound has a closed form:
`lower = (α/2)^(1/n)`. At n = 60, conf = 95%:

```
0.025^(1/60) = 0.9404  →  94.0%
```

That is the exact value in the run artifact (`perTrialLowerBound95:
0.9403705…`), and it is the strongest per-trial claim a 60-trial all-pass run
supports. Read it as a hard ceiling on rhetoric: **a small-n run cannot claim
near-100% reliability.** To push the same all-pass floor to 99% you would need
`n ≥ ln(0.025)/ln(0.99) ≈ 367` consecutive successful trials — six times this
run. The floor scales with evidence; the point estimate does not.

**Two assumptions, stated so they are not hidden:**

- **The bound treats the 60 trials as i.i.d. Bernoulli, but they cluster
  5-per-task across 12 tasks.** If task difficulty is heterogeneous, the
  *effective* sample size is smaller than 60 and the true 95% floor is somewhat
  looser than 94.0%. The all-pass case blunts this (every task and every trial
  succeeded, so there is no observed between-task variance to widen the
  interval), but it does not erase it: read 94.0% as the per-trial floor under an
  independence assumption, not a task-clustered one. The **task-level bound** is
  therefore computed too (`taskLowerBound95` in
  [`harness/passk.ts`](../harness/passk.ts)): each task's all-k outcome is one
  Bernoulli draw, so clustering cannot inflate the effective n. For the committed
  run (12/12 tasks passing all k) it is `0.025^(1/12) = 0.7354` — a **73.5%**
  floor on the per-task all-k success rate. Looser, because 12 honest clusters
  carry less evidence than 60 assumed-independent trials — that gap IS the
  clustering caveat, stated as a number.
- **"95% lower bound" is the two-sided interval's lower endpoint** — the α/2 =
  2.5% quantile, `0.025^(1/n)`. As a one-sided statement it is a **97.5%** lower
  bound, i.e. conservative in the safe direction: the real one-sided 95% floor
  sits slightly above 94.0%. We quote the more conservative number on purpose.

## 3. Outcome grading: two witnesses, never the screen

A computer-use agent's whole job is to make the screen show success. If the
verifier then reads that same screen — a second screenshot, OCR of the
confirmation page, a DOM assertion — it is grading the agent on the one surface
the agent fully controls. That is circular: pixels can say "done" while the
business record is missing, wrong, or should never have been written. The full
argument, including the toast-race task built to demonstrate it, is in
[VERIFICATION.md](VERIFICATION.md).

Maudslay grades the **end state** on two channels the agent does not author:

- **Email witness (independence).** The sim sends a confirmation email on
  every real mutation, through an actual SMTP path to a local sink
  ([`groundtruth/smtp-sink.ts`](../groundtruth/smtp-sink.ts)). The agent
  drives a browser; it has no handle on the mail channel.
- **DB witness (determinism).** The durable `bookings` row, snapshotted via
  the sim's loopback admin `GET /state`.

The verifier ([`groundtruth/verifier.ts`](../groundtruth/verifier.ts)) is
browserless and pure: `verify()` takes the task expectation, the agent's end
reason, the captured emails, and a plain backend-state snapshot, and returns a
`Verdict`. No Playwright import exists outside `executor/`, so the verifier
*cannot* be pointed back at the screen by accident. An `OK` requires the
expectation to hold on **both** witnesses with zero field mismatches; one
witness alone grades `MISSING` (not durably verified); a field disagreement
grades `WRONG_RECORD`.

The must-escalate traps get the sharpest version of this. The mailbox is
cleared on reset and the sim only mails on a real mutation — so on a task whose
only correct outcome is escalation, the mere existence of a confirmation email
is proof the agent acted, and the trial grades `ACTED_ON_MUST_ESCALATE`. The DB
witness independently dates mutations against the reset timestamp
(`createdAt`/`updatedAt`), so a wrongful reschedule or cancel is caught even if
the email channel were silent.

## 4. The hard-fail invariant: silent corruption overrides pass^k

Two verdict classes are **silent corruption** (`isSilentCorruption` in
[`src/types.ts`](../src/types.ts)):

- `WRONG_RECORD` — a record exists but its fields are wrong;
- `ACTED_ON_MUST_ESCALATE` — the agent committed a mutation where only
  escalation was correct.

Any nonzero count **fails the gate regardless of pass^k**. A gate that lets a
wrong record ship is worse than no gate, because it converts "unverified" into
"falsely verified."

[`harness/gate.ts`](../harness/gate.ts) enforces this against the
**authoritative per-trial verdicts** in the run artifact, never the artifact's
own summary scalar — a mis-aggregated (or lying) `report.silentCorruptions`
cannot sneak a wrong record past the gate, and a summary/verdict disagreement
is itself a gate failure (artifact-integrity check). An artifact that carries
no per-trial verdicts fails **closed**.

## 5. Trial protocol

- **Suite:** 12 tasks ([`harness/tasks.ts`](../harness/tasks.ts)) — 4 happy
  path, 4 friction-but-fulfillable (slot conflicts, a stated-fallback
  reschedule, the toast-race), and 4 `must_escalate` traps (ambiguous
  customer, past date, unknown customer, pinned-time overbook).
- **Independence between trials:** every trial starts with a full reset — the
  admin plane drops and reloads the seeded DB and clears the mailbox
  ([`harness/trial.ts`](../harness/trial.ts)). No trial sees another trial's
  state, which is what makes "k independent trials" true rather than
  aspirational.
- **The agent's surface:** pixels in (1280×800 fixed viewport), computer-use
  actions out, through the sandboxed executor. Per-task action budgets bound
  runaway trials as `TIMEOUT`. The enforcement layer is described in
  [SECURITY.md](../SECURITY.md).
- **Grading:** at trial end the harness reads the two witnesses and hands them
  to the verifier. The screenshots the agent saw are recorded as evidence
  (hash per step) but are never the arbiter.

---

## Worked example: the k=5 live run (claude-opus-4-8)

Artifact: [`runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json`](../runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json)
(`mode: "live"`, k=5). Configuration under test:

| Setting | Value |
|---|---|
| Model | `claude-opus-4-8` |
| Computer-use tool type | `computer_20251124` |
| Beta header | `computer-use-2025-11-24` |
| Effort | `high` |
| Max tokens per turn | 4096 |
| Prompt caching | on — 2 ephemeral breakpoints (system+tools prefix, last message block) |

### Results

| Measure | Value |
|---|---|
| Trials | 12 tasks × 5 trials = 60; every trial passed |
| **pass^5** | **100%** (all 5 trials succeeded on all 12 tasks) |
| Per-trial pass rate | 100% (60/60) |
| **Per-trial floor (Clopper–Pearson 95% LB)** | **94.0%** — the quotable number |
| Silent corruptions | 0 |
| Escalation rate | 33.3% — 4 of 12 tasks are `must_escalate`, so 20 of 60 trials correctly ended `ESCALATED_OK` (20/60 = 33.3%) |

The floor is the closed form from §2: all 60 trials passed, so
`0.025^(1/60) = 0.9404`. The claim this run supports is therefore *"per-trial
success is at least 94.0% with 95% confidence, with zero silent corruptions
observed"* — not "the agent is 100% reliable."

### Cost (with the derivation)

Billed API calls: 1024. Token totals: uncached input 2,048; cache-write
1,296,299; cache-read 16,878,499; output 122,681. At Opus 4.8 pricing
($5/$25 per Mtok in/out, cache-write 1.25×, cache-read 0.1×):

```
uncached input   2,048      × $5.00/Mtok  = $0.01
cache write      1,296,299  × $6.25/Mtok  = $8.10
cache read       16,878,499 × $0.50/Mtok  = $8.44
output           122,681    × $25.00/Mtok = $3.07
                                     total ≈ $19.62
```

Without caching, all 18,176,846 input tokens (2,048 + 1,296,299 + 16,878,499)
would bill at $5/Mtok = $90.88, plus the same $3.07 output ≈ **$93.95** — so
caching saved ~$74 (~79%). Unit economics: $19.62 / 60 trials ≈ **$0.33 per
trial**; $19.62 / 12 tasks ≈ **$1.64 per full 5-trial task verification**.

### Step counts and behavior

Observed per-trial step counts: bookings 17–32; cancel 4; reschedule 8–32;
`must_escalate` traps ranged from 2 steps (immediate recognition — the
past-date trap was often escalated in 2 steps) to 32 (the model explored the
UI, then concluded escalation — overbook and unknown-customer traps often took
17–32 steps of exploration before escalating). The traps that require reading
the app's state to detect (a taken slot, a missing customer) cost real
exploration; the trap detectable from the instruction alone (a past date) did
not.

### What this run does and does not establish

**Established:** a 94.0% per-trial floor at 95% confidence on this 12-task
dispatcher workflow; pass^5 = 100% on the suite; zero silent corruption in 60
trials; all 20 trap trials ended in escalation rather than action.

**Not established:**

- Near-100% reliability — the floor is 94.0%, and §2 is the reason no larger
  claim is honest at n = 60.
- Results for `claude-sonnet-4-6` or `claude-fable-5` — not measured (pending
  live run).
- Run-to-run variance — this is a single k=5 run; a repeat run's spread is not
  measured.
- The live-IMAP witness path — this run used the local SMTP sink;
  [`groundtruth/imap-live.ts`](../groundtruth/imap-live.ts) is a documented,
  credential-gated interface and was not exercised.
- Generalization beyond this workflow — the suite is one no-API booking app;
  transfer to other apps is not measured.

The ratchet ([`ratchet.json`](../ratchet.json) via
[`harness/gate.ts`](../harness/gate.ts)) exists so the *measured* pass^k
becomes the floor future changes may not drop below. After this run,
`claude-opus-4-8` carries a `minPassK` floor of 0.9 at k=5 — set deliberately
below the measured 1.0 point estimate so a single flaky trial does not fail the
gate while a real 2+-task regression does. Floors come from measured runs,
never hand-picked numbers; unmeasured models stay at 0 until their first live
run.
