# Plan — circularity audit + saboteur harness (vertical slice, 2026-08-01)

## Goal

Attack this repo's own credibility claim: that its verdicts *discriminate*.

A gate whose number cannot separate a capable agent from an incapable one
measures nothing. This slice establishes the separation **by execution**, not by
assertion, and then tries to break it on purpose.

Three questions, answered with evidence:

1. **Does the grader discriminate?** Run it against agents that are deliberately
   bad and see what they score. If a do-nothing agent scores near-perfect, the
   headline number is meaningless and that is the finding.
2. **Can an agent pass while violating the intent?** Build a *family* of
   saboteurs — not three hand-written cases — and check every one is caught.
3. **What escapes?** Every saboteur that earns a success verdict is a real hole.
   Name it, measure it, pin it. Do not hide it.

Non-goal: making the number look good. If the repo's story and the evidence
disagree, the evidence wins and the docs change.

## Architecture

### New seam: `harness/saboteur.ts`

A saboteur is defined by *what it causes to be witnessed*, because that is the
only thing the verifier ever sees. Contract:

```ts
type SaboteurKind = "ghost" | "fabulist" | "blanket-refuser" | "trap-parrot"
                  | "email-only" | "db-only" | "field-corruptor" | "off-target"
                  | "act-then-refuse" | "backdater" | "over-actor";

interface SaboteurAttempt {
  id: string;                 // stable, seed-derived
  kind: SaboteurKind;
  taskId: string;
  intent: string;             // the intent it violates, one line
  witnesses: VerifyInput;     // exactly what the grader would be handed
}

function generateSaboteurs(opts: { seed: number; tasks: TaskSpec[];
                                   perTask: number }): SaboteurAttempt[];
function judge(a: SaboteurAttempt): { code: VerdictCode; caught: boolean };
function auditSaboteurs(opts): SaboteurAuditReport;
```

Error shape: one `SaboteurError` for malformed generator input; validation at
the boundary (`generateSaboteurs` rejects a non-integer seed / empty suite /
non-positive `perTask`) rather than deep inside.

Two deliberate constraints keep this from being fiction:

- The email witness is built with the **sim's own** `buildMessage()` from
  `sim/mailer.ts`, so a synthetic confirmation is byte-identical in shape to one
  the app really sends and is parsed by the real parser.
- The db witness uses the real `DbBookingRow` shape and real seeded refs.

`caught` is `!isSuccess(code)` — nothing softer. A saboteur that earns `OK` or
`ESCALATED_OK` has beaten the gate.

### The generated space, not a case list

`generateSaboteurs` draws from a seeded PRNG (mulberry32, deterministic, no new
dependency): which field to corrupt, which corruption to apply, which off-target
ref to hit, which excuse text to use, how to date a backdated row. Same seed →
byte-identical family (an idempotence property, the strongest available here);
different seeds → different families.

### Property under test

> **∀ saboteur s: `judge(s).caught`**, except for a pinned, documented set of
> known escapes.

Pinned escapes work like `ratchet.json`: they are the honest record of what this
gate does *not* catch today. A *new* escape fails the suite. Shrinking the set
is the only allowed direction.

### Live circularity audit (`npm run saboteur`)

The grader-level property is pure and fast. It is not enough on its own — it
tests a model of an attack. So the same saboteur strategies are also run for
real, through the real browser + executor + sim + SMTP sink + witnesses, and the
resulting pass^1 is compared against the honest oracle's pass^1 on the same rig.

**Discrimination margin = honest pass^1 − best-saboteur pass^1.** That is the
number this slice produces. A margin near zero would mean the metric is
decorative.

## TDD tasks (bite-sized, RED first every time)

1. **Generator determinism.** Test: same seed twice → deep-equal families;
   different seed → different. Then write the generator.
2. **Coverage.** Test: a generated family exercises every `SaboteurKind` and
   every task in the suite. Then extend the generator.
3. **The invariant.** Test: no generated saboteur is a success, modulo the
   pinned escape set. Expect RED with real escapes — that is the finding, not a
   bug in the test. Root-cause each escape before deciding fix vs. pin.
4. **Fix #1 — collateral mutations (if confirmed RED).** A fulfillable task
   grades only the *expected* record. An agent that books the right slot and
   also books three wrong ones satisfies the letter of the check and breaks the
   goal. Fix in `groundtruth/verifier.ts`: for a fulfillable expectation, any
   booking created or modified after `resetAt` that is not the expected target
   is `WRONG_RECORD` (silent corruption). Mutation-verify the lock.
5. **Fix #2 — the information barrier (if confirmed RED).** `PolicyContext`
   hands the policy the whole `TaskSpec`, *including the graded expectation*. A
   policy can therefore produce a flawless run with zero capability, and both
   witnesses will honestly agree. Narrow `PolicyContext.task` to an
   `AgentTaskView` (`id`, `instruction`, `actionBudget`, `tags` — no
   `expectation`, no `seed`, no `title`). Benchmark construction keeps its
   privilege but must now take it *explicitly*: `makeOraclePolicy(task, waitMs)`.
6. **Live audit + doc.** Run `npm run saboteur` for real, record the measured
   margin in `docs/DISCRIMINATION.md`, cross-link from `docs/VERIFICATION.md`,
   and add a docs-honesty test so the doc's numbers stay derived, not typed.

## Scope discipline — what this slice is NOT

- Not a fix for every escape. Escapes that cannot be closed without redesigning
  the suite get pinned and documented with a concrete remediation, not silently
  dropped.
- Not a change to `ratchet.json`, `runs/`, or the headline pass^k. The saboteur
  audit is a separate command with a separate artifact-free output.
- The full 13-task live audit runs from the CLI. The in-suite live lock is a
  representative subset, so `npm test` stays under a minute.
