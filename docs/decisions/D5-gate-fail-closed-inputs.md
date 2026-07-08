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

## Second round (same audit, adversarial re-verification)

Re-running the attack class against the first fix surfaced four more fail-open
paths, all closed the same way:

- **Stub-mode bypass:** a hand-crafted `mode: "stub"` artifact naming a floored
  model satisfied the floor (golden replay is trivially 100%). A `minPassK > 0`
  floor now requires `mode: "live"`.
- **Self-reported ratchet numbers:** the pass^k floor trusted `report.passK`
  and `run.k`; deleting failing trial records kept a rosy summary enforceable.
  The gate now recomputes pass^k from the per-trial verdicts (the same
  authority the silent-corruption invariant uses), fails on disagreement, and
  fails when any task carries fewer than `k` trial records.
- **The ratchet file itself:** `loadRatchet` swallowed every error into
  `{ models: {} }`, so corrupting ratchet.json (or mistyping `minPassK` as a
  string, which coerced to 0) silently erased every floor. `loadRatchetAudit`
  now fails closed on an existing-but-unreadable config and on present-but-
  non-numeric floor fields. A MISSING ratchet file stays the bootstrap no-op —
  a fork that never promised floors.
- **Test confound:** the on-disk FIX-7 test kept ratchet.json inside the runs
  dir, where it tripped the not-run-shaped branch and masked the JSON.parse
  branch. The fixture now separates them.

Deliberately NOT enforced: artifact presence for `minTasks`/`k`-only entries
(`minPassK: 0`) — sonnet/fable ship exactly that shape while unmeasured, and
the bootstrap depends on it. Their absence IS surfaced as a gate note
("floors dormant"), so deleting such a measurement is visible without failing
the fork that never had one. Also not enforceable at gate level: deleting only
the NEWEST artifact of a multi-artifact model rolls back to the older pass —
the gate has no ledger of what once existed; that deletion, like zeroing
ratchet.json, is a repo-write attack that stays visible in the PR diff. The
residual attacker is the same repo-write attacker as G5's forged-artifact
case. A third round (independent review round) added: unreadable-vs-missing
distinction for both the runs/ directory and ratchet.json (EACCES fails
closed, ENOENT bootstraps).

## Enforcement

Regression-locked as FIX-7 in `tests/integrity-fixes.test.ts` (unit + on-disk
`runGate` cases for corrupt artifact, corrupt ratchet, mistyped floor, missing
ratchet, stub-mode floor, under-k trials, and passK disagreement). Threat model
G5 updated: the residual shrinks to a wholly forged **well-formed live**
artifact from a repo-write attacker (out of scope).
