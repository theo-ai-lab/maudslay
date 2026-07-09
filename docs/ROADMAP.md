# Roadmap

An honest forward plan: what is measured today, and what is deliberately
pending. The rule that governs this file is the same one that governs the rest
of the repo — **no future number is claimed here.** Every item below is tied to
the file or mechanism that already exists to support it, so "pending" means
"wired but unmeasured," not "aspirational." When a pending item is done, it
becomes a committed artifact under [`../runs/`](../runs/) or a filled section of
[DISCOVERY.md](DISCOVERY.md), and its number is read from that artifact — never
typed into this document.

---

## Where the line is today (measured)

Exactly one capability result exists: a **k=5 live run of `claude-opus-4-8`**
(12 tasks × 5 trials = 60 trials), committed as the artifact
[`../runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json`](../runs/claude-opus-4-8-2026-07-05T05-46-13-562Z.json)
and summarized in [MODEL_NOTES.md](MODEL_NOTES.md) §4. What that run measured:

| Metric | Value |
|---|---|
| pass⁵ | 100% (all 5 trials succeeded on all 12 tasks) |
| per-trial pass rate | 100% (60/60) |
| Clopper–Pearson 95% lower bound (per-trial) | **94.0%** — the number to quote |
| silent corruptions (`WRONG_RECORD` / `ACTED_ON_MUST_ESCALATE`) | 0 |
| escalation rate | 33.3% (4 of 12 tasks are `must_escalate` ⇒ 20 of 60 trials ended `ESCALATED_OK`) |
| cost of the run | $19.62 (prompt caching cut it from ~$93.95, ~79%) |

pass⁵ = 100% is the point estimate; the **94.0% Clopper–Pearson floor is the
honest headline** — n=60 all-pass cannot support a stronger claim. Everything
else in the [status matrix](../README.md#status-matrix-measured-vs-pending) is
"green (tests)" — the component's own test file passes. That is plumbing
correctness, **not** a model-capability claim. The distinction is the whole
point of the matrix.

The configured merge floor for `claude-opus-4-8` in
[`../ratchet.json`](../ratchet.json) is `minPassK: 0.9` — set deliberately below
the measured point estimate so one flaky trial does not fail the gate, while a
real 2+-task regression does. Every other model's floor stays at `0` until its
first live run, and `maxSilentCorruptions` is hard-zero for every model.

---

## What is deliberately pending (and the mechanism already in place)

Ordered by how much each would change the thesis. **No number below is
predicted.** Each item names the file that already exists to receive the result.

### 1. A first real user — the un-fakeable item

The one thing no amount of engineering can synthesize. The thesis is that a
two-witness, pass^k, merge-blocking gate is the right *shape* for computer-use
reliability; a thesis survives contact with a real user or it does not.

- **Status:** pending. [DISCOVERY.md](DISCOVERY.md) §1 is a template with every
  field marked `pending first real user` — who they are, the no-API (or
  API-residual) workflow they bring, what "done correctly" means in their words,
  and the pass^k / silent-corruption tolerance **they** would gate on.
- **Why it is the sharpest test:** a real workflow will almost certainly bring a
  witness side-channel that differs from the modeled one (a CSV export or a
  calendar event rather than a confirmation email) — which is exactly the seam
  items 4 and 5 below exist to absorb.
- **The disconfirming version:** [DISCOVERY.md](DISCOVERY.md) §4 already names it
  — run a deliberately weaker or mis-prompted agent and confirm the gate catches
  a real silent corruption end-to-end, not just in unit fixtures. If it does not
  fail when it should, the thesis is wrong.
- **No claim:** no user, no tolerance number, and no field-graded workflow are
  claimed until §1 is filled from something a user actually said.

### 2. A multi-model comparison row

The compounding artifact is model-vs-model on **one** unchanged gate. The model
id is data, not architecture — `ModelConfig` in
[`../src/types.ts`](../src/types.ts) carries `{ model, effort, fallbackToOpus,
maxTokensPerTurn }`, and nothing else in the sim, sandbox, verifier, pass^k math,
or gate is model-coupled.

- **`claude-sonnet-4-6`:** wired and selectable; simply not run. Its row in the
  [per-model table](../README.md#per-model-results) and its floor in
  [`../ratchet.json`](../ratchet.json) both read `pending live run` / `0` until
  an artifact exists. Adding it to the table is a re-run, not a markdown edit —
  [`../harness/report.ts`](../harness/report.ts) renders every cell straight from
  [`../runs/`](../runs/), so **no cell is ever hand-typed.**
- **`claude-fable-5`:** additionally *unverified for the computer-use tool*. Per
  [decisions/D4-cua-api-surface.md](decisions/D4-cua-api-surface.md), the docs'
  model-support list for `computer_20251124` does not include Fable 5, so the
  harness attempts it and surfaces any `400` unmodified rather than assuming
  support ([MODEL_NOTES.md](MODEL_NOTES.md) §2). The pending step here is a
  *support confirmation*, not just a run — until the tool works for that id,
  there is nothing to measure.
- **No claim:** no pass^k, floor, or cost is claimed for any model but
  `claude-opus-4-8`. "Is the cheaper model's floor materially lower?" is the open
  question in [DISCOVERY.md](DISCOVERY.md) §4, not a hypothesis with a number
  attached.

### 3. A larger k and a larger task suite — for a tighter floor

The measured 94.0% floor is bounded by n=60. The Clopper–Pearson lower bound in
[`../harness/passk.ts`](../harness/passk.ts) is a pure function of successes and
trials, so raising the trial count (larger k) or the task count is the only lever
that can move the floor upward on the same all-pass evidence.

- **Mechanism already present:** k is a CLI flag (`npm run trials -- --k N`), and
  the suite size is enforced by `minTasks` in [`../ratchet.json`](../ratchet.json)
  (12 — the measured run's coverage; the suite has since grown to 13 tasks in [`../harness/tasks.ts`](../harness/tasks.ts), and `minTasks` ratchets up to match at the next live run, never before).
  Growing the suite means adding tasks and raising `minTasks` — the gate already
  fails a report that covers fewer tasks than its floor requires.
- **The gap the current suite has:** [DISCOVERY.md](DISCOVERY.md) §4 records it —
  every LIVE trap is "should escalate." The verifier's over-escalation grading is
  now unit-exercised in both directions (`tests/integrity-fixes.test.ts` FIX-10:
  a fulfillable task refused → `ESCALATED_WRONG`, confirmed to be a failure that
  is not a silent corruption), so the code path is no longer untested. The suite now
  carries that task too — `book-disambig-001` (looks like the ambiguity trap,
  but the phone resolves it), golden built and stub-verified. What is still
  pending is a live run over it: over-escalation is now *measurable*, not yet
  *measured*.
- **No claim:** what a larger n would make the floor is **not measured** and is
  not predicted. Whether n=60 is already enough is set by the first real user's
  tolerance (item 1), not by us.

### 4. The failure→golden promotion flywheel, in production

Promotion is built and unit-tested, but has never fired on a *real-world*
failure. [`../harness/promote.ts`](../harness/promote.ts) derives a regression
`TaskSpec` from a failing trajectory — preserving the base expectation verbatim
so the regression re-demands exactly the outcome the model got wrong — and
appends it to `goldens/promoted-tasks.json`, which the suite folds in on the next
run. `buildPromotedTask` and `promoteFailure` are pure and covered, and the
function refuses to promote a success (`OK` / `ESCALATED_OK`) or a
duplicate trajectory.

- **Why pending:** the k=5 `claude-opus-4-8` run produced zero failures, so
  nothing was promoted. The flywheel is validated on fixtures, not on a failure a
  real agent produced. [DISCOVERY.md](DISCOVERY.md) §4 flags it as untested
  against real-world failures.
- **The step to close it:** `npm run promote <taskId> <trajectoryPath>` on the
  first live failure, then confirm the regression variant survives on the next
  run. This is where item 1's "the task the suite is missing" becomes a permanent
  golden.
- **No claim:** the promotion mechanism's *correctness* is measured (its tests);
  its *value* — that a promoted regression catches a re-occurrence — is not yet
  demonstrated end-to-end and is not claimed until it fires on a real failure.

### 5. Live IMAP witness wiring

CI's email witness is the offline SMTP sink, which keeps the pipeline key-free
and deterministic. The same verifier reads a real inbox over IMAP against a live
deployment — the confirmation email is a witness the agent does not author,
whether captured locally or fetched from a mailbox.

- **What exists:** [`../groundtruth/imap-live.ts`](../groundtruth/imap-live.ts)
  is a documented, credential-gated *interface* — `ImapConfig`, `ImapWitness`,
  and `imapConfigFromEnv` (reads `IMAP_*`). It is intentionally **not** a working
  client: the dependency policy in [`../CONTRACTS.md`](../CONTRACTS.md) permits no
  IMAP library, so rather than fake an implementation, `createImapWitness` throws
  loudly with configuration guidance if used. Implementations return
  `CapturedEmail` records shaped identically to the sink's, so
  [`../groundtruth/verifier.ts`](../groundtruth/verifier.ts) is source-agnostic.
- **Why pending:** wiring a real inbox is a **first-user step, not a demo step**
  ([DISCOVERY.md](DISCOVERY.md) §2), and it carries its own secret-management
  requirements that [`../SECURITY.md`](../SECURITY.md) explicitly scopes out of
  this build ("does not secure the live IMAP path's credentials").
- **No claim:** no live-inbox result is claimed; the interface is proven by the
  type identity with the sink, not by a live fetch.

---

## What will not change (the invariants under all of the above)

Every item above is a re-run or a wiring step. None of them relaxes the gate.
These hold across every future model, every larger k, and every new witness:

- **Silent corruptions are hard-zero.** Any nonzero `WRONG_RECORD` or
  `ACTED_ON_MUST_ESCALATE` fails the gate regardless of pass^k
  ([`../harness/gate.ts`](../harness/gate.ts), `isSilentCorruption` in
  [`../src/types.ts`](../src/types.ts)). A gate that ships a wrong record is
  worse than no gate.
- **Verification never reads the screen.** Two independent witnesses (email +
  backend row), never a second screenshot — the design invariant in
  [`../CONTRACTS.md`](../CONTRACTS.md).
- **No number is hand-typed.** Every measured cell is rendered from a committed
  `runs/` artifact by [`../harness/report.ts`](../harness/report.ts); a pending
  cell renders `pending live run`.
- **The floor ratchets up from measurement, never down to a guess.**
  [`../ratchet.json`](../ratchet.json) floors start at `0` and rise only from a
  real run's measured pass^k.

---

## The pending list, at a glance

| Pending item | Un-fakeable? | Mechanism already in place | Where its result lands |
|---|:---:|---|---|
| First real user | yes | [DISCOVERY.md](DISCOVERY.md) §1 template | DISCOVERY.md §1 |
| `sonnet-4-6` row | no | [`../harness/report.ts`](../harness/report.ts) + [`../ratchet.json`](../ratchet.json) | [`../runs/`](../runs/) artifact |
| `fable-5` row | no (blocked on CUA support) | [D4](decisions/D4-cua-api-surface.md) unverified-flag policy | [`../runs/`](../runs/) once supported |
| Tighter floor (larger k / suite) | no | [`../harness/passk.ts`](../harness/passk.ts), `minTasks` in ratchet | [`../runs/`](../runs/) artifact |
| Promotion flywheel in production | no | [`../harness/promote.ts`](../harness/promote.ts) | `goldens/promoted-tasks.json` |
| Live IMAP witness | no | [`../groundtruth/imap-live.ts`](../groundtruth/imap-live.ts) interface | live-run witness output |

The only row that cannot be closed by writing code is the first one. That is by
design: it is the test the rest of the project is built to earn.
