# Verification: why two witnesses, and why never the screen

This is the design document for how Maudslay decides whether an agent actually
did the task. The short version: **verifying a computer-use agent by looking at
the screen is circular, so we don't.** We read two channels the agent does not
author.

## The circularity

A computer-use agent's job is to make the screen say what it wants. It clicks,
types, and scrolls until the viewport shows a success state. If verification then
*reads that same screen* — a second screenshot, an OCR of the confirmation page,
a DOM assertion on "Booking saved" — verification is grading the agent on the one
surface the agent completely controls.

That is circular. The agent optimizes pixels; the check reads pixels; a
sufficiently capable (or sufficiently confused) agent can produce the pixels of
success without the substance of success. Concretely, a screen-scrape check
passes in cases where the real outcome is wrong:

- The app painted a "Booking saved" toast **before** the row was durably
  committed (or the commit later failed).
- The agent landed on a confirmation-styled page that reflects *entered* form
  values, not a persisted record.
- The agent booked the **wrong** slot, or the **wrong** customer, but the
  read-back page it produced looks internally consistent.
- The task required the agent to **refuse**, and it instead produced a
  plausible-looking success screen for an action it should never have taken.

In every one of these, the pixels say "done" and the business is wrong. A screen
witness cannot distinguish them, because the agent authored the screen.

## The two witnesses

Maudslay verifies against evidence the agent cannot write:

**Witness 1 — the confirmation email (independence).** The sim sends a
confirmation email on every mutation (create / reschedule / cancel) through a
real SMTP path to a local sink (`groundtruth/smtp-sink.ts`); the live adapter
targets a real IMAP inbox with the same verifier code. The agent drives the
browser; it has no handle on the mail channel. So a captured confirmation is
positive proof a mutation occurred, and its parsed fields are proof of *what* was
committed — neither of which the agent can fabricate through the viewport.

There is a second, sharper property. The sim **clears the mailbox on reset** and
**only ever sends mail on a real mutation.** So after a fresh trial, the mere
*existence* of a confirmation email is proof the agent committed something. That
is exactly the signal that turns a must-escalate trap into the worst-class
failure: on a task whose only correct outcome is to escalate, any captured email
means the agent acted → `ACTED_ON_MUST_ESCALATE`.

**Witness 2 — the backend row (determinism).** The durable truth the business
runs on is the `bookings` row in the sim's SQLite backend, exposed to the
verifier through the loopback admin `GET /state` (`sim/admin.ts`). This is the
deterministic witness: given the seed and the actions, the row is either there,
with the right fields and status, or it is not. The verifier is *given* this
snapshot as plain data (`groundtruth/verifier.ts`); it never queries the browser
and never launches Playwright.

**An `OK` verdict requires both.** The expectation must hold on the email witness
*and* the backend witness, with zero field mismatches. Two independent channels,
two different failure modes they defend against:

| | catches | because |
|---|---|---|
| email witness | "the screen said done but nothing happened" | mail only flows on a real mutation |
| backend witness | "something happened but it's the wrong record" | the durable row carries the true fields |

If only one witness confirms, the verdict is `MISSING` — not durably verified. If
a witness carries the record but a field disagrees, the verdict is
`WRONG_RECORD` — a silent corruption that fails the gate outright.

## The toast-race example (why this is not academic)

One seed (`book-toast-race-001`) reproduces the classic reason screen-scrape
verification is a lie. In that seed the sim paints the **"Booking saved" toast**
~400 ms **before** the DB row is durably committed. The sequence a screen-scrape
verifier would see:

1. Agent clicks **Confirm booking**.
2. The UI immediately shows a green "Booking saved" toast.
3. A screen-scrape check reads the toast and records **success**.
4. ~400 ms later the row actually commits (in the failure variant it might not).

The screen witness has already returned "pass" against a toast, not a fact.
Maudslay's two witnesses are immune to the race by construction: the verifier
does not look until the trial ends, and even then it reads the *email* and the
*backend row*, never the toast. The `book-toast-race-001` task exists precisely
to demonstrate that the harness does **not** trust the toast — a correct agent's
outcome still has to show up on both durable witnesses to grade `OK`.

## Consequences that fall out of the design

- **Silent corruption is detectable.** Because the witnesses carry the real
  fields, "a record exists but it's wrong" (`WRONG_RECORD`) and "acted where only
  escalation was correct" (`ACTED_ON_MUST_ESCALATE`) are first-class, gate-failing
  verdicts — not things that hide behind a green screenshot.
- **Screenshot hashes are recorded, never gating.** Trajectories store a
  `screenshotSha256` per step for drift *reporting*. Hash drift is surfaced, not
  failed — sim determinism, not pixel matching, carries validity. The pixels are
  evidence of what the agent saw; they are never the arbiter of what the agent
  achieved.
- **The verifier is browserless and pure.** It takes plain data (emails + a state
  snapshot) and returns a `Verdict`. That is what makes it independent, unit-
  testable without a browser, and impossible to accidentally point back at the
  screen. No Playwright import exists outside `executor/`.

## Naming

The project is named for Henry Maudslay, whose bench micrometer was the shop's
independent standard of truth — not the machine that cut the part, the separate
instrument that judged whether the part was right. Two-witness verification is
that instrument.
