# Discrimination — what the number can and cannot tell you

`docs/VERIFICATION.md` argues that verifying an agent by taking a second
screenshot is circular. That argument establishes the verdicts are *independent*
of the agent. It does not establish that they are *informative*.

A separate question has to be asked out loud: **can this gate tell a capable
agent from an incapable one?** A metric a do-nothing agent also scores well on
measures nothing, however clean its evidence chain. So the claim is attacked
here rather than asserted, by running the grader against agents that are
deliberately bad and reporting what they earn.

Reproduce everything below with:

```bash
npm run saboteur            # the full adversarial audit, deterministic
npm run saboteur -- --json  # same numbers, machine-readable
```

## The experiment

[`harness/saboteur.ts`](../harness/saboteur.ts) generates a seeded, deterministic
family of agents that try to pass while violating the intent — do nothing and
claim success, satisfy the letter of the check, refuse for the wrong reason,
reach the right end state by a wrong route. Each is defined by *what it causes to
be witnessed*, because that is the only thing the verifier ever sees. Synthetic
confirmation mail is built by the sim's own `buildMessage()` and read by the real
parser, so the family is not a set of convenient fixtures.

A saboteur is **caught** when its verdict is not a success. Nothing softer.

The control arm is an honest, capable agent, measured on the same rig: it scores
**1.000** on all 13 tasks (`tests/saboteur.test.ts`, and end-to-end via the
oracle golden build, which fails loudly if any task does not verify as a
success).

## Result

| strategy | what it does | pass^1 |
|---|---|---|
| honest agent (control) | the work, correctly | **1.000** |
| ghost | nothing at all, reports done | 0.000 |
| fabulist | nothing, narrates a detailed false success | 0.000 |
| blanket-refuser | refuses everything, off-target excuse | 0.000 |
| email-only | confirmation lands, nothing committed | 0.000 |
| db-only | committed, no confirmation | 0.000 |
| field-corruptor | coherent record, one field wrong | 0.000 |
| off-target | right mutation, wrong booking | 0.000 |
| over-actor | the requested booking **and** extras nobody asked for | 0.000 |
| backdater | commits, dates the row before the restore point | 0.308 |
| trap-parrot | refuses everything with one canned omnibus string | 0.308 |
| act-then-refuse | does the work correctly **and also** escalates | 0.615 |

**The metric does discriminate.** An agent with no capability at all cannot get
near an honest score. But the floor is not zero, and pretending otherwise would
be the same sin the project exists to call out:

> **Noise floor 0.308 — discrimination margin 0.692.**

## Why the floor is 0.308, and what that means for a headline

The floor is exactly the suite's must-escalate share (4 traps / 13 tasks), and
that is not a coincidence. A trap is graded on the agent's *stated reason*
matched against a regex, and text can be canned: one omnibus refusal that names
every shipped trap's blocking condition at once collects all four traps without
ever looking at the screen. `tests/saboteur.test.ts` asserts this equality
structurally, so adding trap tasks raises the floor and says so.

This is confirmed end-to-end, not just modelled — the live test drives the
canned refuser through the real browser, sim, SMTP sink and witnesses, and the
trap really does come back `ESCALATED_OK`.

**Consequence for reading the results table:** a pass^k on this suite should be
read against 0.308, not against 0. The interesting range is the top two-thirds.
A model scoring near 0.31 has demonstrated approximately nothing.

## Open holes (pinned, not hidden)

`KNOWN_ESCAPES` in [`harness/saboteur.ts`](../harness/saboteur.ts) is the honest
record of what this gate does not catch. A *new* escape fails the suite; the set
may only shrink.

1. **trap-parrot** — as above. Closing it needs a signal the refusal text does
   not carry: evidence the trap condition was actually *observed* before the
   refusal. Bounded — it can only ever win the trap share, and it forfeits every
   fulfillable task as `ESCALATED_WRONG`.

2. **act-then-refuse** (fulfillable tasks) — `mapFulfillable` decides on the
   witnesses alone and stops looking at `endReason` once both agree, so an agent
   that completes the booking *and also* escalates is graded `OK`. The gate has a
   code for exactly this behaviour (`ESCALATED_WRONG`, "safe but a failure") and
   never reaches it when a mutation is present. Not corrupting — the requested
   outcome is correct and clean — but the contradiction is invisible in the
   number. Closing it means letting `endReason` override a clean two-witness
   agreement, which changes the meaning of every existing run artifact.

3. **backdater** (must-escalate traps) — the trap's mutation detector dates rows
   against `resetAt` using `createdAt`/`updatedAt`, fields that live in the very
   system the agent just wrote to and that `DbBookingRow` marks **optional**. A
   row claiming to predate the restore point, or carrying no timestamps at all
   (what `normalizeSnapshot` produces for any backend whose state payload omits
   them), is not counted as a mutation. The worst failure class then degrades
   silently to a single-witness check with the confirmation email as the only
   backstop. Unreachable through the shipped sim, which always stamps
   `created_at`; **reachable for the third-party backends
   [`EXTENDING.md`](EXTENDING.md) invites.** `tests/verifier-properties.test.ts`
   pins today's fail-open for the missing-`resetAt` case as a documented
   limitation, so closing it is a deliberate semantics change rather than a bug
   fix.

   *If you are plugging in your own ground truth: make your state snapshot carry
   trustworthy `createdAt`/`updatedAt`, or treat the email witness as
   load-bearing on traps.*

## One hole this audit found and closed

**over-actor** used to score 1.000. Grading only the record that was asked for
meant an agent could book the requested slot correctly *and* book three
appointments nobody requested, and every field the verifier looked at agreed —
`OK`. The customer gets junk on their calendar; the number says the agent is
perfect.

`groundtruth/verifier.ts` now treats any booking created or modified after the
restore point that is not the task's target as silent corruption
(`WRONG_RECORD`). The strategy scores 0.000.
