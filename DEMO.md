# Maudslay — 5-minute local runbook

This walks the whole gate on your machine, key-free, in about five minutes: the
same sequence CI runs. Nothing here needs an API key. A key is required only for
the optional live-model run at the end.

**What you are proving locally:** the harness, sim, and two-witness verifier are
wired and deterministic, and the merge-blocking gate enforces its invariants.
The stub path replays known-good golden trajectories — it is a plumbing and
determinism check, **not** a model-capability measurement. Measured pass^k comes
only from a live run whose artifacts land under `runs/`.

## 0. Prerequisites

- Node **>= 24** (native TypeScript type-stripping; no build step). Check with
  `node --version`.
- A machine that can run headless Chromium (the oracle and trials drive a real
  browser through the executor).

## 1. Install (~90s)

```sh
npm ci
npx playwright install chromium
```

On CI/Linux the browser install uses `npx playwright install --with-deps chromium`
to pull system libraries; locally, `chromium` alone is usually enough. If `npm ci`
fails on a missing optional dependency, see [Troubleshooting](#troubleshooting).

## 2. Typecheck + tests (~1–2 min)

```sh
npm run typecheck
npm test
```

`npm test` runs the whole `node --test tests/` suite (sim, ground truth, executor,
agent, harness, mcp, and the CI + docs contract checks). Browser-dependent tests skip
cleanly if Chromium can't launch, and a fast non-browser path always covers the
core logic.

## 3. Build the oracle goldens (~30s)

```sh
npm run oracle
```

The oracle is **benchmark construction, disclosed as such**: a scripted driver
that already knows each task's correct answer and records one golden trajectory
per task into `goldens/`. It is not the subject under test. A golden that does
not verify as a success on both witnesses is rejected at build time, so a clean
run means every golden is a genuine two-witness success.

## 4. Stub-replay trials (~30s)

```sh
npm run trials -- --model stub
```

This replays the goldens deterministically and writes a run artifact to
`runs/stub-<timestamp>.json`. The command prints a per-task verdict line and a
summary, and reminds you the numbers measure harness + sim determinism, not model
capability. Because it replays known-good goldens, it carries zero silent
corruptions by construction.

## 5. Run the gate

```sh
npm run gate
```

The gate reads the latest run artifact per model plus `ratchet.json` and prints
either `GATE PASS — ...` or `GATE FAIL` with the exact failing reason, and sets
its exit code accordingly (0 pass / 1 fail). With only a stub run present it
passes with an explicit "stub-replay plumbing runs only — no live-model runs to
ratchet" label. Its hard invariant is absolute: **any** silent corruption
(`WRONG_RECORD` or `ACTED_ON_MUST_ESCALATE`) fails the gate regardless of pass^k.

Optional — render the per-model markdown table (empty cells read "pending live
run" until a live artifact exists):

```sh
npm run report
```

That is the full key-free gate. Everything above is what the `gate` job in
`.github/workflows/gate.yml` runs on every push and pull request.

## 6. Optional — a live model run (needs an API key)

A live run is the only thing that produces a **measured** pass^k. Set your key
(copy `.env.example` to `.env` and fill `ANTHROPIC_API_KEY`, or export it), then
run trials against a real model and re-run the gate:

```sh
export ANTHROPIC_API_KEY=sk-...        # your Anthropic key
npm run trials -- --model claude-opus-4-8 --k 5
npm run gate
npm run report
```

This runs the observe→act loop over the executor surface, verifies each trial
against the confirmation email and backend state, and writes a live artifact to
`runs/`. The `report` table then fills in from that artifact — no number is ever
hand-written. In CI this is the manual `live` job in `gate.yml`
(`workflow_dispatch`), which reads the `ANTHROPIC_API_KEY` repository secret and
uploads `runs/` as a build artifact.

Other live models the harness accepts: `claude-fable-5`, `claude-sonnet-4-6`.
`claude-fable-5` runs with server-side fallback to `claude-opus-4-8` on refusal.

## Exploring the pieces (optional)

Each service can run on its own against the fixed local topology:

```sh
npm run sim     # no-API booking app on http://127.0.0.1:4380 (admin on :4381)
npm run sink    # SMTP sink on 127.0.0.1:4325, mail persisted under var/mail/
npm run mcp     # ground-truth MCP server over stdio (JSON-RPC 2.0)
```

All runtime artifacts land under `var/` (gitignored): `var/sim.sqlite`,
`var/mail/`, `var/trajectories/`.

## Troubleshooting

- **`npm ci` fails on a missing optional dependency** (often an `@emnapi/*` or
  other platform-specific optional dep): the committed `package-lock.json` was
  generated on macOS and may omit a Linux-only optional dep. Regenerate it
  cross-platform and commit the result:

  ```sh
  npx npm@latest --package-lock-only
  ```

  Do not hand-edit the lockfile.

- **Chromium won't launch** (missing system libraries on Linux): install with
  system deps: `npx playwright install --with-deps chromium`. The test suite
  degrades gracefully — browser tests skip and the logic tests still run — but
  the oracle and trials genuinely need a working browser.

- **Live trials abort with "requires ANTHROPIC_API_KEY"**: that path is
  key-gated by design. Set the key (step 6) or stay on `--model stub`.
