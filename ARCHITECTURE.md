# Architecture

Maudslay is a gate. Everything in the tree serves one asymmetry: **the agent
under test only ever sees pixels and only ever emits actions; verification only
ever reads channels the agent does not author.** This document maps the
directories to that asymmetry and traces one trial end to end.

## The data-flow asymmetry (read this first)

```
   agent  ──actions (click/type/scroll/screenshot)──▶  executor ──▶  sim UI
     ▲                                                                  │
     └────────────── pixels (base64 PNG screenshot) ◀───────────────────┘

   verification path (never touches the screen):

   sim ──confirmation email──▶  SMTP sink ──▶  email witness ─┐
   sim ──durable row────────▶  SQLite    ──▶  db witness ────┴──▶ verifier ──▶ verdict
```

- **Outbound from the agent:** only `CUAction` values (`src/types.ts`), executed
  through the sandbox. The agent's whole world is a 1280×800 viewport of the sim.
- **Inbound to the agent:** only screenshots. It never receives DOM, database
  rows, or email.
- **Verification:** reads the confirmation **email** (an independence witness, a
  channel the agent cannot write to) and the **backend state** (a determinism
  witness, via the loopback admin `GET /state`). It never launches a browser and
  never reads a pixel. This is enforced structurally: no Playwright import exists
  outside `executor/`.

Why the asymmetry matters is argued in [docs/VERIFICATION.md](docs/VERIFICATION.md):
verifying an agent by taking a second screenshot is circular, because the agent
controls the pixels. The email and the backend row are not the agent's to forge.

## Fixed topology

| Endpoint | Address | Who talks to it |
|---|---|---|
| Sim public UI | `http://127.0.0.1:4380` | the agent (via the executor) only |
| Sim admin (reset/seed/state/health) | `http://127.0.0.1:4381` | the harness & verifier only — loopback, never the agent |
| SMTP sink | `127.0.0.1:4325` | the sim's mailer sends here; captured to `var/mail/*.json` |
| SQLite DB | `var/sim.sqlite` | the sim writes; the db witness reads via admin `/state` |

Viewport is a fixed 1280×800. All runtime artifacts live under `var/`
(gitignored). Run evidence is committed under `runs/`; golden trajectories under
`goldens/`.

## Track / directory map

Each directory is one build track against the frozen contracts in
[`src/types.ts`](src/types.ts) and [CONTRACTS.md](CONTRACTS.md).

### `sim/` — the no-API dispatcher ("HearthDesk")
A deliberately un-automatable, server-rendered field-service booking app: forms
POST and the server re-renders; there is **no booking JSON API**, so the only way
to create/reschedule/cancel is to drive the HTML. This is the residual "visual
interaction only where no API exists" domain the AWS GA endorses.

- `server.ts` — `node:http` static + form endpoints (`/`, `/new`, `/new/review`,
  `/new/confirm`, `POST /bookings`, `/booking/:ref`). Commit controls carry
  `data-guard="irreversible"`; a decoy "Save draft" is `data-guard="reversible"`.
- `db.ts` — `node:sqlite` schema: `customers`, `technicians`, `slots`,
  `bookings` (ref codes `HD-XXXXXX`).
- `seed.ts` — named deterministic seed profiles + the date anchor logic.
- `mailer.ts` — minimal SMTP client that sends a confirmation email (created /
  rescheduled / cancelled) to the sink on every mutation.
- `admin.ts` — loopback-only `POST /reset?seed=`, `GET /state`, `GET /health`
  (the db witness + the CI readiness probe).
- `public/` — stylesheet and static assets for the hostile-but-fair UI.

### `groundtruth/` — the witnesses and the verifier
- `smtp-sink.ts` — a zero-dependency `node:net` SMTP server (HELO/MAIL/RCPT/DATA)
  that persists one JSON file per captured message.
- `email-store.ts` — read/query/clear captured mail.
- `email-parse.ts` — extract the booking fields + ref + kind from a confirmation
  body.
- `verifier.ts` — the two-witness verdict engine. Given a task expectation, the
  captured emails, and a backend-state snapshot, it returns a `Verdict`. It reads
  plain data only.
- `imap-live.ts` — a documented, credential-gated interface stub for the live
  IMAP mode (same verifier code, a real inbox instead of the sink). Marked as an
  interface, not fake-implemented.

### `executor/` — the only agent-facing surface
- `browser.ts` — Playwright chromium lifecycle at the fixed viewport.
- `tools.ts` — executes a `CUAction` and returns an `ActionResult` + `Observation`.
  This is where the DOM guard read happens (`elementFromPoint` at the click
  coordinate → nearest `data-guard` value).
- `sandbox.ts` — the enforcement layer: origin allowlist (`127.0.0.1:4380`
  only), viewport-bounds check, per-trial action budget, and the irreversible-
  click approval gate. Config-driven guard rules so a live deployment can
  classify differently. Pure and browserless, so it is exhaustively unit-tested.
- `recorder.ts` — writes the trajectory JSONL (`TrajectoryLine`).

### `agent/` — the subject under test
- `model.ts` — the Anthropic computer-use client (tool type `computer_20251124`,
  beta `computer-use-2025-11-24`; model-configurable per `ModelConfig`).
- `loop.ts` — the observe→act loop over the executor surface: screenshot each
  turn, map the model's tool calls to `CUAction`, feed the next screenshot back
  as a `tool_result` image.
- `stub-policy.ts` — deterministic replay of a golden action sequence (no pixel
  matching; sim determinism carries validity; hash drift is *reported*, not
  failed).
- `approval.ts` — the `ApprovalPolicy` implementations (auto-log / cli / mcp).

### `harness/` — trials, statistics, and the gate
- `tasks.ts` — the 12-task golden suite (happy paths, friction/conflict,
  `must_escalate` traps) per [D2](docs/decisions/D2-task-suite.md).
- `trial.ts` / `trial-cli.ts` — reset sim → run policy → verify → restore;
  produce `TrialResult`; the `npm run trials` entry point.
- `oracle.ts` — the scripted driver that *knows* the sim and records golden
  trajectories. It is benchmark construction, disclosed as such — **not** the
  subject under test.
- `passk.ts` — pass^k and the Clopper–Pearson exact 95% lower bound; pure
  functions unit-tested against known values.
- `runs.ts` — the run-artifact schema and readers (`runs/`): `readRunsAudit`
  separates well-formed runs from unreadable files; `readRuns` stays the lenient
  rendering surface.
- `gate.ts` — reads `runs/` + `ratchet.json` → `GateOutcome` + exit code. Fails
  hard on any silent corruption; fails closed on unreadable artifact files and
  on configured floors with no artifact to enforce them against
  ([D5](docs/decisions/D5-gate-fail-closed-inputs.md)); no artifacts **and**
  nothing ratcheted = labelled plumbing-only pass. The full decision flow is
  diagrammed in [`docs/DIAGRAMS.md`](docs/DIAGRAMS.md).
- `report.ts` — renders the per-model markdown table from artifacts (never by
  hand).
- `promote.ts` — promotes a discovered failure into a new golden.

### `mcp/` — ground truth over MCP
- `server.ts` — a zero-dependency stdio JSON-RPC 2.0 MCP server exposing the
  witnesses: `verify_booking`, `await_confirmation`, `list_captured_mail`,
  `request_approval`. It reuses `groundtruth/verifier.ts` and, like the verifier,
  never reads the screen.

### docs & CI
- `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `docs/` — this track (T8).
- `.github/workflows/gate.yml`, `.env.example`, `DEMO.md` — CI (T7): install →
  playwright → typecheck → tests → oracle goldens → stub-replay trials → gate,
  plus a key-gated manual live-run job.

## A trial, end to end

1. **Reset.** The harness calls admin `POST /reset?seed=<name>`: the DB is
   dropped, recreated, and loaded from the named seed; the mailbox is cleared.
   The reset timestamp is remembered so the db witness can date new rows.
2. **Run.** The policy (stub replay, or a live model through `agent/loop.ts`)
   drives the sim through the executor. Every action passes the sandbox: origin,
   bounds, budget, and — on a click landing on `data-guard="irreversible"` — an
   approval decision. Each step is recorded to a trajectory JSONL.
3. **Terminate.** The trial ends on the agent's `done`/`escalate`, on budget
   exhaustion, on a sandbox block, or on error.
4. **Verify — the two witnesses.** The verifier reads (a) the confirmation
   emails the sink captured and (b) the backend snapshot from admin `GET /state`,
   and compares both against the task's `expectation`. Agreement on both with
   zero mismatches → `OK`; a field mismatch → `WRONG_RECORD`; a mutation on a
   `must_escalate` task → `ACTED_ON_MUST_ESCALATE`.
5. **Restore.** State is reset for the next trial.
6. **Aggregate & gate.** `passk.ts` builds the `PassKReport`; `trial-cli.ts`
   writes a `runs/` artifact; `gate.ts` reads the latest artifact per model
   against `ratchet.json`. Any silent corruption fails outright; otherwise the
   ratchet floors decide, and with no live artifacts the gate is a labelled
   plumbing-only pass.

## Determinism, honesty, and what is and is not measured

- **Stub replay** (`--model stub`) exercises the harness, sim determinism, and
  trajectory validity with no key and no network. It is a *plumbing regression
  gate*, labelled as such everywhere — it is not a model-capability claim.
- **pass^k numbers** exist only when produced by a live-model run whose artifact
  is committed under `runs/`. `report.ts` renders them; nothing is hand-written.
- **The oracle** is how the goldens are built. It is disclosed as benchmark
  construction and is never presented as the agent under test.
