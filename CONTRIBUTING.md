# Contributing

Maudslay is a merge-blocking release gate, so the bar for changes to it is the
same bar it holds agents to: measured, outcome-verified, honest about what is
and is not known. This document covers the dev loop, the module boundaries, the
ethos, and exactly how CI gates a pull request.

## Dev setup

Requirements: **Node >= 24** (native TypeScript type-stripping — no build
step) and a machine that can run headless Chromium.

```sh
npm ci
npx playwright install chromium     # CI uses --with-deps on Linux
npm run typecheck                   # tsc --noEmit
npm test                            # node --test --test-concurrency=1 tests/*.test.ts
```

Tests run **serially** on purpose (`--test-concurrency=1` in
[package.json](package.json)): the harness binds a fixed local topology — sim
`127.0.0.1:4380`, admin `:4381`, SMTP sink `:4325`, artifacts under `var/` —
and parallel test files would fight over it. Browser-dependent tests skip
cleanly if Chromium cannot launch; the logic tests still run.

The full key-free loop, identical to what CI runs on every push:

```sh
npm run oracle                      # build golden trajectories (benchmark construction)
npm run trials -- --model stub      # deterministic golden replay -> runs/ artifact
npm run gate                        # merge-blocking gate; exit 0 pass / 1 fail
```

The 5-minute walkthrough with expectations per step is [DEMO.md](DEMO.md).
Handy while developing: `npm run sim` (the app alone), `npm run sink` (the
SMTP sink alone), `npm run mcp` (ground truth over stdio), `npm run report`
(render the per-model table from `runs/`), `npm run promote` (failure →
regression). `MAUDSLAY_TODAY=YYYY-MM-DD` pins the sim's date anchor for
reproducible sessions.

## Module boundaries

Modules depend on each other **only through the frozen types in
[`src/types.ts`](src/types.ts)** — change a type there first, then update the
consumers. The full contracts are in [CONTRACTS.md](CONTRACTS.md); the short
map:

| Directory | Role | Tests |
|---|---|---|
| `sim/` | the no-API booking app under test (server-rendered forms, no booking JSON API) | `tests/sim.test.ts` |
| `groundtruth/` | SMTP sink, email parsing, the two-witness verifier | `tests/groundtruth.test.ts` |
| `executor/` | the only agent-facing surface: browser, `CUAction` execution, sandbox, trajectory recorder | `tests/executor.test.ts` |
| `agent/` | the subject under test: model client, observe→act loop, stub replay, approvals | `tests/agent.test.ts` |
| `harness/` | tasks, trials, pass^k statistics, the gate, reporting, promotion | `tests/harness.test.ts` |
| `mcp/` | ground truth exposed over stdio JSON-RPC (MCP) | `tests/mcp.test.ts` |
| `.github/`, `DEMO.md`, `.env.example` | CI and ops | `tests/ci.test.ts` |
| `README.md`, `docs/`, `SECURITY.md` | docs — tested like code | `tests/docs.test.ts` |

Two structural rules are load-bearing and non-negotiable:

1. **No Playwright import outside `executor/`.** Verifiers read plain data
   (captured mail + a backend snapshot), never the screen. This is the
   project's core asymmetry — see [docs/VERIFICATION.md](docs/VERIFICATION.md).
2. **Only two dependencies: `playwright` and `@anthropic-ai/sdk`.** Everything
   else is Node built-ins (`node:http`, `node:net`, `node:sqlite`,
   `node:test`, ...). Do not add dependencies.

TypeScript constraints (Node 24 type-stripping, `erasableSyntaxOnly`): no
enums, no namespaces, no parameter properties; import paths end in `.ts`; use
`import type` for types.

## The ethos

- **No fabricated numbers, anywhere.** A performance number exists only if a
  run artifact under `runs/` produced it. The per-model README table is
  rendered by [`harness/report.ts`](harness/report.ts) from artifacts — no
  cell is ever typed by hand; cells without an artifact read *pending live
  run*. Ratchet floors in [`ratchet.json`](ratchet.json) start at 0 and only
  ratchet **up** from a measured run. Parts of this are enforced mechanically:
  `tests/docs.test.ts` rejects a percentage in the per-model table body, and
  the gate cross-checks an artifact's summary against its per-trial verdicts.
- **New files first, additive by default.** New capability arrives as new
  files plus its own new tests covering new ground. Existing tests are
  contracts (`tests/docs.test.ts` pins the README's honesty guarantees;
  `tests/ci.test.ts` cross-checks every `npm run` the workflow references
  against `package.json`) — never weaken one to make a change pass. If a
  contract is genuinely wrong, change the contract deliberately, in its own
  commit, with the reasoning written down.
- **Honest labels.** Stub replay is a plumbing/determinism check, not a
  capability claim. The oracle is benchmark construction, not the subject
  under test. Keep both labelled that way in anything you write.
- **Comments explain *why*, sparingly.**

Extending the task suite or porting the gate to a new domain has its own
guide: [docs/EXTENDING.md](docs/EXTENDING.md).

## How CI gates a PR

[.github/workflows/gate.yml](.github/workflows/gate.yml) has two jobs.

**`gate`** runs on every push and pull request, key-free, on `ubuntu-latest`:

```
npm ci
npx playwright install --with-deps chromium
npm run typecheck
npm test
npm run oracle                      # goldens must verify as successes to build
npm run trials -- --model stub      # deterministic replay of the goldens
npm run gate                        # exit code decides the check
```

The gate ([`harness/gate.ts`](harness/gate.ts)) reads the latest run artifact
per model plus `ratchet.json` and exits nonzero on:

- **any silent corruption** (`WRONG_RECORD` / `ACTED_ON_MUST_ESCALATE`) in any
  model's latest artifact — counted from the per-trial verdicts, never the
  summary scalar, and failing closed if an artifact carries no verdicts;
- a ratcheted model dropping below its `minPassK` floor, shrinking below
  `minTasks` coverage, or running fewer than the configured `k`;
- a malformed report where a ratchet floor is configured (fails closed).

With no artifacts at all it is a labelled plumbing-only pass. A green `gate`
check on a PR therefore means: types check, every module's tests pass, the
goldens rebuild and verify on both witnesses, the stub replay reproduces them
deterministically, and no committed artifact violates the invariants. It does
**not** by itself claim anything about live model capability.

**`live`** is manual (`workflow_dispatch`) and key-gated by the
`ANTHROPIC_API_KEY` repository secret: it runs real trials
(`--model claude-opus-4-8 --k 5`), re-runs the gate, and uploads `runs/` and
`var/trajectories/` as build artifacts — uploading **even if the gate fails**,
so a failing live run's evidence (including any silent corruption) is
preserved for inspection. This is the only path that produces a measured
pass^k. When a live artifact is committed, ratchet the model's floor up to the
measured value — never past it, and never by hand to a number nobody measured.

## Pitfalls worth knowing

- **macOS → Linux lockfile.** `package-lock.json` committed from a mac can
  omit Linux-only optional deps and break `npm ci` on the runner. Regenerate
  cross-platform with `npx npm@latest --package-lock-only` and commit the
  result; never hand-edit the lockfile.
- **Port collisions.** A stray `npm run sim`/`npm run sink` left running will
  fight the test suite for 4380/4381/4325.
- **Partial live runs fail coverage — by design.** A live run with
  `--tasks <id>` becomes that model's latest artifact and the gate will fail
  its `minTasks` floor. Use partial runs for development; gate on the full
  suite.
- **Secrets.** `ANTHROPIC_API_KEY` is read from the environment, never
  committed; `.env` is gitignored. Everything under `var/` is gitignored;
  committed evidence (`runs/`, `goldens/`) carries verdicts and screenshot
  hashes, not raw screenshots or captured mail.

## Security-sensitive changes

Changes to the sandbox (`executor/sandbox.ts`), the guard classification
(`executor/tools.ts`), or the verifier's silent-corruption detection
(`groundtruth/verifier.ts`) alter the gate's guarantees — read
[SECURITY.md](SECURITY.md) first, and state explicitly in the PR what the
change does to the threat model. If you find an enforcement bypass, open an
issue describing the bypass and the expected verdict.
