# Discovery write-up

> **Status: live run DONE (findings below); first real user still pending.**
>
> One of the two contact points now exists: a **k=5 live run of
> `claude-opus-4-8`** (60 trials, artifact committed under `runs/`). Its findings
> fill §3–§4 below. The other — a **first real user** putting the gate against a
> workflow they care about — does not exist yet, so §1 stays pending. Every
> number here comes from the committed artifact or the usage log; nothing is
> hand-typed.

Maudslay's thesis is that a two-witness, pass^k, merge-blocking gate is the right
shape for computer-use reliability. A thesis survives contact with a real user or
it doesn't. This write-up is where that contact gets recorded honestly — what
held, what broke, what we cut, and what to measure next.

---

## 1. Who the user is

*(Fill after the first real user. Be concrete — a role and a workflow, not a
persona.)*

- **Who:** _pending first real user_ — the person or team, their role, and why
  a computer-use reliability gate is on their critical path.
- **The workflow they brought:** _pending_ — the specific no-API (or
  API-residual) task they need graded, and what "done correctly" means to them in
  their own words.
- **What they do today instead:** _pending_ — manual QA, screen-scrape checks,
  spot-audits, nothing? What failure got them looking?
- **What "good enough to ship" means to them:** _pending_ — the pass^k and the
  silent-corruption tolerance they'd actually gate on (their number, not ours).

## 2. What we cut to get here

The scope deliberately not built, and why.

- **Cut: one workflow, one no-API app.** No multi-app flows, no create-customer
  path, no second vertical. The bet is that a single, deep, honestly-graded
  workflow proves the *gate* better than a broad shallow demo — the gate is the
  product, the dispatcher is the fixture.
- **Cut: live IMAP beyond an interface stub.** The email witness runs against an
  offline SMTP sink so CI is key-free and deterministic; `groundtruth/imap-live.ts`
  is a documented, credential-gated interface, not a fake implementation. The same
  verifier code targets a real inbox when wired — but that wiring is a real-user
  step, not a demo step.
- **Cut: models beyond the three configured, and Fable-5 CUA.** Only
  `claude-opus-4-8` is measured; sonnet/fable rows are honestly pending, and
  Fable-5 is flagged unverified for the computer-use tool rather than assumed.
- **The cut we're least sure about:** the single-workflow scope. It's the right
  call for proving the gate, but a real user will almost certainly bring a
  workflow whose witness side-channel (confirmation email vs CSV export vs
  calendar) differs from the one modeled here — and that's exactly the seam §4
  wants to test next.

## 3. What surprised us

Findings from the k=5 `claude-opus-4-8` run (60 trials, all passed).

- **The design creaked before the model did — and a live run is what caught it.**
  The *first* live attempt (k=1) surfaced a real grading bug: two reschedule
  tasks that errored before the agent acted were graded `WRONG_RECORD` — a
  silent-corruption class — purely because the untouched pre-existing booking
  didn't match the expected new slot. A false silent-corruption would have failed
  the gate for the wrong reason. The verifier now requires a *witnessed mutation*
  (`updated_at > resetAt`, or a reschedule email) before calling a mismatch
  corruption. No amount of stub-replay testing had found this; it took a real
  agent that fails in a realistic way. This is the single strongest argument for
  running the gate against a live model, not just deterministic replays.
- **Escalation latency varies enormously, and that's a signal, not noise.** All 4
  must-escalate traps were escalated correctly in all 20 trials, but the *effort*
  differed by an order of magnitude: `escalate-pastdate` was usually recognized
  in **2 steps** (the disabled date is visible immediately), while `overbook` and
  `unknown-customer` took **17–32 steps** of UI exploration before the model
  concluded escalation was correct. "Knowing when not to act" is not a single
  behavior — some refusals are cheap and some are expensive, and a cost-aware gate
  should track that.
- **The number to quote is the floor, not the point estimate.** pass⁵ was 100%
  (60/60), but the honest headline is the **Clopper–Pearson 95% lower bound of
  94.0%** — n=60 all-pass simply cannot support a stronger claim. Reporting "100%"
  would be true and misleading; the floor is true and defensible.
- **A cost number that surprised us.** The run cost **$19.62**, but the same run
  *without* prompt caching would have cost **~$93.95** — caching cut it ~79%. The
  driver is that the computer-use loop never prunes screenshots, so input grows
  quadratically with trial length; two cache breakpoints turn that into
  cache-reads at 0.1×. Cost-per-verified-task (~$1.64 at k=5) is only affordable
  *because* of that design choice. See [COST.md](COST.md).

## 4. What to measure next

Ordered by what would most change our mind.

- **A second and third model row.** `claude-sonnet-4-6` on the same v0 suite (is
  the cheaper model's floor materially lower?), and `claude-fable-5` *if* it turns
  out to support the computer-use tool (Anthropic's docs don't currently list it —
  see [MODEL_NOTES.md](MODEL_NOTES.md)). Model-vs-model on one gate is the
  compounding artifact.
- **Larger k and larger n for a tighter floor.** The 94.0% floor is bounded by
  n=60. A first real user's tolerance (§1) sets whether that's already enough or
  whether k and the task count need to grow.
- **The task the suite is missing.** Whatever a real user's workflow breaks on,
  promoted into a golden via `npm run promote` — the failure→golden flywheel is
  untested against real-world failures so far.
- **The metric we trust least:** the escalation-*calibration* — the traps are all
  "should escalate," but we have no "looks-ambiguous-but-is-actually-fulfillable"
  tasks yet, so we can't measure over-escalation (a model that escalates
  everything would score `ESCALATED_WRONG`, which the verifier grades but the v0
  suite never exercises).
- **The disconfirming test:** run a deliberately *weaker* or mis-prompted agent
  and confirm the gate actually catches a real silent corruption end-to-end (not
  just in the unit fixtures). If it doesn't fail when it should, the thesis is
  wrong and the gate is theater.

---

## How to fill this in (for the next maintainer)

1. Run the live path once it is affordable: `export ANTHROPIC_API_KEY=…` then
   `npm run trials -- --model claude-opus-4-8 --k 5`, and commit the resulting
   `runs/` artifact. `npm run report` renders the measured table.
2. Replace each `pending` placeholder with the observed fact. If a value is a
   number, it must come from a committed artifact — never hand-typed.
3. If a finding contradicts a claim in the README, fix the README. Discovery
   outranks marketing.
4. Keep the honesty rule: a sentence here is either something a user said, a
   number an artifact recorded, or an explicitly-labelled open question.
