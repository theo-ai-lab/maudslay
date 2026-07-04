# D3 — README shape & positioning (honesty-first)

The README's hero is **the gate**, not a demo GIF. Structure:

1. **One-line thesis + result banner.** "Outcome-verified release gating for
   computer-use agents — pass^k measured against independent ground truth
   (confirmation email + backend state), never a second screen-scrape." Banner
   shows the CI gate badge and a status word (plumbing-green / awaiting live
   run). NO fabricated pass^k in the banner.

2. **Why this exists (motivating literature, cited).**
   - Anthropic's eval guidance (Jan 2026): pass^k for consistency-critical
     agents; grade the *actual end state* "not just that the confirmation page
     appeared"; run evals in CI on every change. Link it. Maudslay implements
     exactly this recipe for computer-use.
   - OSWorld 2.0 (Jun 26 2026): best model 20.6% on long-horizon tasks →
     reliability, not capability, is the bottleneck. This is the gap Maudslay
     gates.
   - AWS agent-desktops GA (Jun 30 2026): MCP-first, "visual interaction only
     where no API exists" → no-API workflows are the residual CUA domain, which
     is exactly what the sim models. This scoping is deliberate, not arbitrary.

3. **The wedge, stated precisely (comparison table).** Columns: outcome-graded?
   independent ground-truth channel? pass^k? merge-blocking CI? computer-use?
   Rows: Maudslay | [ASSERT](link) (policy-driven LLM-judge over traces) |
   [EvalView](link) (trajectory-snapshot diff). Maudslay is the only row with
   all five. NO "nobody does evals" claim — it would be false; the table is the
   claim.

4. **How the gate works (the two-witness diagram).** agent → pixels only;
   verification → email witness (independence) + db witness (determinism);
   verdict semantics incl. the silent-corruption hard-fail invariant.

5. **Status matrix (measured vs pending).** A table with explicit columns:
   Component | State | Evidence. Harness/sim/verifier/gate = "green (tests)".
   Model pass^k = "pending live run" until `runs/` artifacts exist. This is the
   honesty spine — never present plumbing-green as capability.

6. **Model-configurable + per-model pass^k table.** Show the table STRUCTURE
   (models: fable-5, opus-4-8, sonnet-4-6; columns: pass^5, per-trial floor
   [Clopper–Pearson 95% LB], silent corruptions, escalation rate, $/verified
   task) rendered by `report.ts` from artifacts. Empty cells = "pending live
   run". The table proves the harness survives model churn (the compounding
   property).

7. **Quickstart.** `npm ci && npx playwright install chromium && npm test`;
   then `npm run oracle && npm run trials -- --model stub && npm run gate`.
   Live run: set `ANTHROPIC_API_KEY`, `npm run trials -- --model claude-opus-4-8`.

8. **Discovery write-up link** (`docs/DISCOVERY.md`, filled after the first
   real user + live run — template committed, marked pending).

9. **Security note link** (`SECURITY.md`): the agent ingests hostile page
   content; what the sandbox blocks; what the gate does and does not guarantee.

Tone: precise, unhedged where evidence exists, explicitly pending where it does
not. Never a number we didn't measure.
