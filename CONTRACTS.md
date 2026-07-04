# Maudslay — Module Contracts

This document defines the module boundaries and the contracts between them. Each
module owns one directory and depends on the others only through the frozen types
in `src/types.ts`, which is the single source of truth for the interfaces. Change
a type here first, then update the modules that consume it.

## What Maudslay is

**The first open outcome-graded, ground-truth-verified, pass^k merge-blocking
release gate for computer-use agents** — demonstrated end-to-end on one no-API
field-service dispatcher workflow.

Positioning (verified July 2026): AWS's GA agent-desktop architecture is
MCP-first with "visual interaction only where no API exists" — no-API apps are
the industry-endorsed *residual* domain of computer use. Existing open tools
grade adjacent things: ASSERT (policy-driven LLM-judge over traces; no gate, no
pass^k, no CUA) and EvalView (merge-blocking trajectory-snapshot diff; not
outcome-graded, no CUA). Maudslay's wedge is the conjunction: **outcome-graded
+ independent ground-truth side-channel + pass^k + merge-blocking + CUA.**

Core principle: **the agent proposes, ground truth disposes.** The agent under
test sees only pixels and emits only computer-use actions. Verification reads
two independent witnesses — the confirmation **email** (captured by a local
SMTP sink in CI; same verifier code targets real IMAP live) and the app's
**backend state** — never the screen.

## Fixed topology

- Sim app: `http://127.0.0.1:4380` (public UI), admin `127.0.0.1:4381` (reset/seed/state; loopback only)
- SMTP sink: `127.0.0.1:4325`; captured mail persisted as JSON files in `var/mail/`
- SQLite DB: `var/sim.sqlite` (node:sqlite, zero native deps)
- Viewport: fixed 1280×800
- All runtime artifacts under `var/` (gitignored)

## Non-negotiable rules (every module)

1. **No fabricated numbers anywhere.** No example pass^k values presented as
   results. Tables that need live-run data render "pending live run".
2. **TypeScript, Node 24, type-stripping compatible** (`erasableSyntaxOnly`:
   no enums, no namespaces, import paths end in `.ts`). `npm run typecheck`
   must pass. Tests: `node --test --test-concurrency=1 tests/*.test.ts`
   (node:test, no test framework dependency).
3. **Only dependencies: `playwright`, `@anthropic-ai/sdk`.** Everything else is
   Node built-ins (`node:http`, `node:net`, `node:sqlite`, `node:crypto`, ...).
4. **Verifiers never read the screen.** No Playwright imports outside
   `executor/`. The DOM is available to the *sandbox* (enforcement layer) only.
5. Comments explain *why*, sparingly.
6. Each module has its tests in `tests/<module>.test.ts` and leaves them green.

## Module boundaries

| Module | Owns | Responsibilities |
|---|---|---|
| T1 sim | `sim/` | No-API booking app: `server.ts` (node:http static+form endpoints — forms post, server renders; NO JSON API for booking ops), `db.ts` (node:sqlite schema: customers, technicians, slots, bookings w/ ref codes), `seed.ts` (named deterministic seed profiles), `mailer.ts` (minimal SMTP client → sink; sends confirmation email on create/reschedule/cancel with ref, fields), `admin.ts` (loopback: POST /reset?seed=, GET /state for the db witness), `public/` hostile-but-fair UI per docs/decisions/D1.md. Confirm buttons carry `data-guard="irreversible"`. |
| T2 groundtruth | `groundtruth/` | `smtp-sink.ts` (zero-dep `node:net` SMTP server: HELO/MAIL/RCPT/DATA happy path; persists JSON per message to `var/mail/`), `email-store.ts` (read/query/clear captured mail), `email-parse.ts` (extract booking fields+ref from confirmation bodies), `verifier.ts` (two-witness verdicts per `src/types.ts` semantics; email witness from store, db witness via admin GET /state), `imap-live.ts` (documented interface stub for live IMAP mode — clearly marked credential-gated, not fake-implemented). |
| T3 executor | `executor/` | `browser.ts` (Playwright chromium lifecycle, fixed viewport), `tools.ts` (the ONLY agent-facing surface: execute `CUAction` → `ActionResult`+`Observation`), `sandbox.ts` (origin allowlist 127.0.0.1:4380 only; viewport bounds check; action budget; irreversible-click interception via `elementFromPoint` → `data-guard` attr → approval flow; config-driven guard rules so live mode can classify differently), `recorder.ts` (trajectory JSONL writer per `TrajectoryLine`). |
| T4 agent | `agent/` | `model.ts` (Anthropic client; model-configurable per `ModelConfig`; computer-use tool type + betas per Anthropic's public computer-use documentation, exact strings pinned in `docs/decisions/D4-cua-api-surface.md`; Fable 5: omit `thinking`, include server-side `fallbacks:[{model:"claude-opus-4-8"}]` with beta `server-side-fallback-2026-06-01` when `fallbackToOpus`, handle `stop_reason:"refusal"`; no temperature/top_p; effort via `output_config`), `loop.ts` (observe→act loop over T3's surface; screenshot each turn; parse model tool calls → `CUAction`), `stub-policy.ts` (deterministic replay of a golden trajectory's action sequence — no pixel matching, sim determinism carries validity; hash drift is REPORTED not failed), `approval.ts` (ApprovalPolicy impl: auto-log / cli / mcp). |
| T5 harness | `harness/` | `tasks.ts` (task suite per docs/decisions/D2.md: happy paths, conflict/reschedule, `must_escalate` traps), `trial.ts` (reset sim → run policy → verify → restore; returns `TrialResult`), `trial-cli.ts`, `oracle.ts` (scripted driver that KNOWS the sim — records golden trajectories; disclosed as benchmark construction, it is not the agent under test), `passk.ts` (pass^k + Clopper–Pearson lower bound; pure functions, unit-tested against known values), `gate.ts` (reads `runs/` artifacts + `ratchet.json` → GateOutcome; exit code; ALWAYS fails on silentCorruptions>0; "no live runs yet" = plumbing-only pass, clearly labeled), `report.ts` (per-model markdown table gen), `promote.ts` (failure→golden promotion). |
| T6 mcp | `mcp/` | `server.ts` — zero-dep stdio JSON-RPC 2.0 MCP server exposing ground truth: `verify_booking(ref, expectation?)`, `await_confirmation(ref, timeoutMs)`, `list_captured_mail()`, `request_approval(actionSummary)` → decision. Reuses T2 verifier. Include `initialize`/`tools/list`/`tools/call` handshake per MCP spec. |
| T7 ci | `.github/workflows/gate.yml`, `.env.example`, `DEMO.md` | CI: npm ci → playwright install chromium → typecheck → tests → oracle goldens → stub-replay trials → `gate.ts`. Key-gated live-run job (manual dispatch, `ANTHROPIC_API_KEY` secret) that runs real trials and uploads `runs/` artifacts. DEMO.md: 5-minute local runbook. Note macOS→Linux lockfile regen guidance (`npx npm@latest --package-lock-only`). |
| T8 docs | `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `docs/` | README per docs/decisions/D3.md: hero = the gate; honest status matrix (measured vs pending); comparison table vs ASSERT & EvalView (linked, factual); AWS residual-domain framing; cite Anthropic eval guidance (pass^k, end-state grading, CI evals) + OSWorld 2.0 long-horizon gap as motivation; model-configurable + per-model pass^k table (structure shown, "pending live run"); quickstart; discovery write-up template `docs/DISCOVERY.md`; `docs/VERIFICATION.md` (two-witness design + why screen-scrape verification is circular); `SECURITY.md` (prompt-injection surface: hostile page content → agent; sandbox rules; what the gate does/doesn't protect). |

## Verdict semantics (authoritative)

See `src/types.ts` `VerdictCode` docblock. The gate's hard invariant:
**silent corruptions (WRONG_RECORD or ACTED_ON_MUST_ESCALATE) are never
acceptable** — any nonzero count fails the gate regardless of pass^k.

## What honesty looks like here

- Stub-replay CI proves *harness + sim determinism + trajectory validity* — it
  is a plumbing regression gate, not a model capability claim. Label it so.
- pass^k numbers exist only when produced by live-model runs whose artifacts
  are committed under `runs/`. The README table renders them from artifacts,
  never hand-written.
- The oracle is benchmark construction, not the subject under test. Say so.
