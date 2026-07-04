# Discovery write-up

> **Status: pending first real user + live run.**
>
> This document is a **template**, deliberately committed empty of findings. It
> gets filled *after* two things exist that do not exist yet: (1) a first real
> user putting the gate against a workflow they actually care about, and (2) a
> live-model run whose artifacts land under `runs/`. Until then every "finding"
> below is a prompt, not a claim. **No numbers appear here that were not
> measured** — where a measured value belongs, the placeholder reads
> `pending live run`.

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

*(Fill from the build. The honest list of scope we deliberately did not build,
and why the cut was right — or where it will hurt.)*

- **Cut:** _pending_ — e.g. multi-app workflows, a create-customer flow, live
  IMAP wiring beyond the interface stub, models beyond the three configured.
- **Why the cut was defensible:** _pending_ — what the cut bought (a shippable,
  honest, key-free plumbing gate) and what it costs.
- **The cut we're least sure about:** _pending_ — the one most likely to be
  wrong when a real user pushes on it.

## 3. What surprised us

*(Fill after the live run. The findings you could not have predicted from the
plumbing-green state. This is the section that earns the document.)*

- **Biggest surprise:** _pending live run._
- **Where the two-witness design paid off unexpectedly:** _pending live run_ —
  e.g. a case a screen-scrape check would have passed that a witness caught.
- **Where the design creaked:** _pending live run_ — a false verdict class, a
  flaky trial, a task the suite mis-graded, a guard the sandbox mis-classified.
- **A number that surprised us:** _pending live run_ — the measured pass^k, the
  Clopper–Pearson floor, or a silent-corruption count, versus what we expected.

## 4. What to measure next

*(Fill continuously. The queue of the next honest measurements, ordered by what
would most change our mind.)*

- **Next measurement:** _pending_ — e.g. per-model pass^5 on the v0 suite for
  `claude-opus-4-8`, then the ratchet floor it establishes.
- **The task the suite is missing:** _pending_ — the failure a real user hit that
  should be promoted into a golden via `npm run promote`.
- **The metric we don't yet trust:** _pending_ — what we'd want a second,
  independent measurement of before believing it (cost/verified-task, escalation
  rate calibration, etc.).
- **The disconfirming test:** _pending_ — the experiment most likely to *refute*
  the thesis, and what result would make us change the gate's design.

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
