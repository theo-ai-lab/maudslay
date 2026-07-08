# D5 — The gate fails closed on its own inputs (2026-07)

A post-build adversarial audit found two fail-open paths in the merge gate that
the trial-level invariants (FIX-2) did not cover:

1. `readRuns` silently skipped a `runs/*.json` file it could not parse (or that
   was not run-shaped). Byte-corrupting the committed `claude-opus-4-8` artifact
   left the gate PASSING on the stub artifact alone.
2. `evaluateGate` iterated only the models **present in artifacts**, never the
   models the ratchet **promises floors for**. Deleting the artifact entirely
   also left the gate PASSING — a 0.9 floor silently un-enforced.

## Decision

- `harness/runs.ts` gains `readRunsAudit(dir)` returning `{ runs, invalid }`;
  `readRuns` stays the lenient rendering/promotion surface (report, promote —
  behavior unchanged) and is now a wrapper over the audit reader.
- `evaluateGate(runs, ratchet, invalidFiles = [])`: every invalid file is a gate
  failure; every ratchet entry with `minPassK > 0` and no artifact for its model
  is a gate failure ("the floor cannot be enforced; failing closed").
- The labelled no-op PASS on an empty `runs/` survives **only when nothing is
  ratcheted** — the fresh-fork bootstrap case. In this repo, where an opus floor
  is configured and its artifact is committed, an empty or corrupted `runs/` can
  no longer pass.

Rejected: throwing inside `readRuns` (would crash `report`/`promote`, which are
rendering surfaces where a skipped file is the right behavior); enforcing
artifact presence for every ratchet entry regardless of floor (fable/sonnet sit
at `minPassK: 0` until measured — requiring artifacts for them would break the
bootstrap and contradict "a floor is never a number nobody measured").

## Enforcement

Regression-locked as FIX-7 in `tests/integrity-fixes.test.ts` (unit + on-disk
`runGate` case). Threat model G5 updated: the residual shrinks to a wholly
forged **well-formed** artifact from a repo-write attacker (out of scope).
