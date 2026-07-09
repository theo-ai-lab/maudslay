# Diagrams

## Gate decision flow (fail-closed)

Every reject edge converges on a hard FAIL. The only pass-with-notes paths are genuine bootstrap states (no runs yet, no floors configured) and dormant floors, which are named in the output rather than silently skipped. Source of truth: `harness/gate.ts`.

The check order below mirrors `evaluateGate`: config validation, then the
artifact-presence and rollback-pin checks, then — per artifact — the
silent-corruption invariant **first** (it is the hard invariant, enforced before
any floor), then the ratchet floor.

```mermaid
graph TD
  A[npm run gate] --> B{runs/ dir}
  B -->|missing: bootstrap| P0[PASS + notes]
  B -->|unreadable| F[FAIL closed]
  B -->|readable| C{all artifacts parse}
  C -->|invalid file| F
  C -->|ok| D{ratchet.json}
  D -->|missing: no floors yet| P0
  D -->|corrupt / mistyped / out of range / nonzero maxSilentCorruptions| F
  D -->|valid| PIN{pinnedArtifact set?}
  PIN -->|pinned, latest != pin| F
  PIN -->|no pin, or latest == pin| E{floor minPassK > 0 has an artifact?}
  E -->|minPassK > 0, no artifact| F
  E -->|minPassK == 0, no artifact| N[note: dormant floor]
  E -->|artifact present| SC{silentCorruptions == 0 from trials}
  SC -->|any corruption| F
  SC -->|zero| XC{report.silentCorruptions == derived}
  XC -->|mismatch| F
  XC -->|match| FL{floor configured for this model?}
  FL -->|no| PN[PASS + note: no floor]
  FL -->|yes| H{coverage >= minTasks and k >= floor.k}
  H -->|short| F
  H -->|ok, minPassK > 0| G{mode == live}
  G -->|stub replay| F
  G -->|live| I{k distinct trialIndex per task}
  I -->|padded / missing| F
  I -->|ok| J{derived passK == reported}
  J -->|mismatch| F
  J -->|match| K{passK >= minPassK}
  K -->|below| F
  K -->|meets| P[PASS: floor enforced]
```
