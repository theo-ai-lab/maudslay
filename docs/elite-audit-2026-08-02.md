# Ship-gate ledger — maudslay, 2026-08-02

Branch: `hardening/grader-false-ok-and-witness-persistence`. Two verdicts,
reported separately and never merged.

## What this gate caught

**"A floor is never hand-set to a number nobody measured" was false as worded.**
The shipped floor for `claude-opus-4-8` is `0.9`. The measurement was
pass^5 = 1.0 (60/60). Nobody measured 0.9 — it is a deliberate one-notch margin
so a single flaky trial does not fail the gate while a two-task regression
still does. That is a sound engineering choice and a false sentence at the same
time. `ratchet.json`'s own comment already explained the margin; the README and
`EXTENDING.md` did not, so a reader checking config against claim would have hit
the contradiction before finding the reasoning. Both now name the 1.0
measurement and the 0.9 choice at the point the claim is made.

## Scores

| # | Principle | Score | Evidence |
|---|---|---|---|
| P12 | Testing | **4** | 329 tests, 0 failures; `tsc --noEmit` clean; cold clone verified. `npm run gate` passes as a fused command. |
| P13 | CI/CD | **3** | Merge-blocking release gate with content-addressed artifact pinning: the gate verifies the selected artifact hashes to its `sha256` pin, so a deleted-newest rollback or an edited artifact fails closed. **Evidence is the PR run.** |
| P14 | Observability | **3** | Per-trial artifacts under `runs/` with `generatedAt` and raw bytes retained; witness persistence added on this branch. |
| P15 | Security fundamentals | **3** | Read-only grading path; no credentials in the repo; tripwire CLEAN across 96 tracked files. |
| P19 | Infrastructure | **3** | Node harness, stub and live model paths, deterministic replay from committed artifacts. |
| P24 | Measurable success criteria | **3** | The 94.0% floor comes from a real k=5 live run. Scored 3 not 4: k=5 over a 12-task suite does not support three-significant-figure precision, and the ledger backing the per-run cost claims is gitignored, so those figures are not reproducible from the repository. |
| P32 | Graders | **4** | The grader's own false-OK failure mode is the thing this branch attacked: a booking row with no technician is now reported *unchecked* rather than silently passed. A grader that cannot say "I did not check this" is the defect class the whole repo exists to catch. |
| P36 | Onboarding / accurate mental models | **3** | External adversarial review by an independent frontier model from a different vendor. Fixed the hand-set contradiction. Recorded as open: the published live result has no committed raw transcript, so the headline is an assertion inside a document rather than an auditable artifact; and the README implies the approval layer blocks actions while the measured live path auto-approved all of them. |

## Verdict 1 — Build Quality

**Strong.** The content-addressed ratchet pin is the standout: it closes the
rollback attack on your own evidence, where deleting the newest artifact
silently lowers the bar. Pinning the hash means the gate fails closed instead.

The weakness is evidential rather than structural. The numbers that matter most
— the live pass^k and the per-run costs — rest on artifacts that are either
uncommitted or gitignored, so a reader cannot re-derive them. The gate is
rigorous about artifacts it can see.

## Verdict 2 — External Adoption / Production Validation

**Unproven. No external users.** One live k=5 run by the author against a
self-defined 12-task suite. No third party has run the harness, no external
model provider's results have been independently reproduced, and the sonnet run
at the predeclared 0.9 bar has not been executed.
