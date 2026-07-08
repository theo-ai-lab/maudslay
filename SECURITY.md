# Security model

Maudslay drives a browser agent against a web app it does not trust, and then
decides — from independent evidence — whether that agent did the right thing.
This document states the threat surface, the primary defense, and, just as
importantly, **what the gate does and does not guarantee.**

## The threat: the agent ingests hostile page content

The agent under test only ever sees pixels. Those pixels come from a web page,
and a web page is attacker-controllable content. In Maudslay's CI the sim serves
**hostile-but-fair** content on purpose (misleading toasts, a decoy "Save draft"
button, ambiguous customer matches, inline conflict errors). In a live
deployment the page could be genuinely adversarial.

The concrete risk is **prompt injection through the screen.** Text rendered on
the page — a fake instruction, a spoofed confirmation, a forged "your manager
approved this" banner — can try to steer the model into committing an
irreversible action (booking, rescheduling, cancelling) that the real task did
not call for. Because the model's only input is the rendered viewport, anything
paintable is a potential injection vector. This is a known property of
computer-use models, not a Maudslay-specific weakness.

## Primary defense: the `data-guard` approval gate

Maudslay does **not** rely on the model recognizing the injection. The one-way
doors are guarded structurally, below the model, in the sandbox.

- Every irreversible commit control in the sim carries
  `data-guard="irreversible"` (`sim/server.ts`). Reversible decoys carry
  `data-guard="reversible"` and book nothing.
- When the agent clicks, the executor reads the nearest `[data-guard]` value at
  the exact click coordinate via `elementFromPoint` (`executor/tools.ts`), and
  the sandbox (`executor/sandbox.ts`) classifies it against config-driven
  `guardRules`. `irreversible` → **require approval**; anything unlisted →
  `allow`.
- On `require_approval` the sandbox raises an `ApprovalRequest` and blocks the
  action until an `ApprovalDecision` comes back. The decision — not the model's
  confidence — is what opens the door. Every decision is recorded for evidence.
- The gate **fails closed**: if the DOM guard read throws (`failClosedOnGuardError`),
  the click is treated as requiring approval. A denied or unresolved approval
  returns an `approval_required` block and the action does not execute.
- Approval policy is pluggable (`agent/approval.ts`): `auto-log` (approve and
  record — CI/stub convenience), `cli` (block for a human on the terminal), or
  `mcp` (surface via the MCP server's `request_approval` tool to an external
  reviewer). The `deny`-all default is the safe posture when no policy is wired.

The point of this design: the decision to open a one-way door is **external to
the model** and cannot be reached by any single input the agent chooses. Both
routes to a commit are gated:

- **Pointer** — a `click`/`double_click` on an `irreversible` element requires
  approval.
- **Keyboard** — a commit-capable key (`Enter`/`Space`) while an `irreversible`
  element is focused, and a `type` action carrying a newline, are gated the same
  way via the focused-element guard read (`executor/tools.ts`). Without this, an
  agent could `Tab` to Confirm and press `Enter` to bypass a click-only guard.

The guarantee is over the **actor** (the model under test), not over the app: a
trusted app annotates its commit controls with `data-guard`, and no choice of
action modality lets the agent commit an annotated control without an external
approval decision. It is **not** a claim that arbitrary page JavaScript cannot
alter its own DOM — an app that fails to annotate a control, or actively strips
the attribute, is outside this control's scope (see *What the gate does NOT
guarantee*), which is exactly why the two-witness detection layer exists.

**Known limitation (TOCTOU).** The guard is read in one page round-trip
(`elementFromPoint` / `activeElement`) and the action lands in a separate one, so
a page that mutates the DOM between the two could in principle desynchronize the
read from the target. This is not exploitable against the controlled sim (no
adversarial client-side script), and the two-witness detection layer catches the
*outcome* regardless; a live deployment against untrusted pages should treat the
guard as best-effort prevention backed by outcome verification, not an atomic
interlock.

### Other sandbox controls

Independent of the guard gate, every action is re-checked by the sandbox before
it reaches the browser:

- **Origin allowlist** — interaction is confined to `http://127.0.0.1:4380`; any
  navigation off-origin is an `origin_denied` block. A page cannot lure the agent
  to an external site.
- **Viewport bounds** — clicks outside 0..1279 × 0..799 are `viewport_bounds`
  blocks.
- **Action budget** — a per-trial cap bounds runaway behavior; exhaustion is a
  block, and the trial is graded `TIMEOUT`, not silently passed.

## The second line: two-witness verification catches what slips through

Even if an injection did coax an unwanted commit, the gate is designed to
**catch the outcome**, not just the intent. Verification reads the confirmation
email and the backend row — channels the hostile page cannot author. A booking
that should never have happened shows up as a captured confirmation email after a
reset-cleared mailbox and as a new backend row, which the verifier grades
`ACTED_ON_MUST_ESCALATE` — a **silent-corruption** class that fails the gate
outright, regardless of pass^k. Prevention (the guard gate) and detection (the
two witnesses) are separate layers on purpose.

## What the gate does NOT guarantee

Being explicit about the boundary is part of the security posture. The gate does
**not**:

- **Does not** make the agent injection-proof. It bounds and detects the
  *actions* an injected agent can take; it does not harden the model's
  perception. A model that is fooled still gets stopped at the door or caught by
  the witnesses — but "fooled" is not prevented.
- **Does not** depend on, or vouch for, the Claude computer-use model's own
  injection classifier. That classifier may insert its own confirmation steps;
  Maudslay's `data-guard` gate is independent of it and is the control we rely
  on. We do not claim the model's classifier is sufficient.
- **Does not** protect actions the sim does not mark. The guard gate is only as
  complete as the `data-guard` annotations and the `guardRules` config. An
  unmarked irreversible control would not be gated at click time — it would only
  be *caught after the fact* by the two-witness verifier. Marking coverage is a
  maintained invariant of the sim, not an automatic property.
- **Does not** guarantee a passing gate means the agent is safe to deploy. A
  green gate means: on this fixed 12-task suite, at the configured k, this model
  met its ratchet floor and produced zero witnessed silent corruptions. It is a
  floor on measured reliability for a specific suite — not a proof of general
  safety, and not a claim about tasks outside the suite.
- **Does not** secure the live IMAP path's credentials. `groundtruth/imap-live.ts`
  is a credential-gated interface stub; wiring a real inbox is out of scope here
  and carries its own secret-management requirements.

## Trust boundaries and secrets

- The admin endpoints (`127.0.0.1:4381`: reset/seed/state) are the db witness and
  the harness's control plane. They are **loopback-only** and are never exposed
  to the agent. Binding them to a routable interface would hand the agent (or an
  injection) a non-visual mutation surface and break the whole premise — do not.
- `ANTHROPIC_API_KEY` is required only for live runs. It is read from the
  environment, never committed, and is the sole reason the live-run CI job is
  manual-dispatch and key-gated. `.env` files are gitignored.
- All runtime artifacts (`var/`) are gitignored. Committed evidence (`runs/`)
  contains per-trial verdicts and screenshot **hashes** — not
  raw screenshots or captured mail.

## Reporting

This is a research demonstrator, not a hosted service. If you find a defect in
the sandbox's enforcement, the guard classification, or the verifier's silent-
corruption detection, open an issue describing the bypass and the expected
verdict.
