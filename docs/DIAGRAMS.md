# Diagrams

## Gate decision flow (fail-closed)

Every reject edge converges on a hard FAIL. The only pass-with-notes paths are genuine bootstrap states (no runs yet, no floors configured) and dormant floors, which are named in the output rather than silently skipped. Source of truth: `harness/gate.ts`.

```mermaid
graph TD
  A[npm run gate] --> B{runs/ dir}
  B -->|missing: bootstrap| P0[PASS + notes]
  B -->|unreadable| F[FAIL closed]
  B -->|readable| C{all artifacts parse}
  C -->|invalid file| F
  C -->|ok| D{ratchet.json}
  D -->|missing: no floors yet| P0
  D -->|corrupt / mistyped / out of range| F
  D -->|valid| E{model floor minPassK > 0}
  E -->|no artifact| F
  E -->|artifact| G{mode == live}
  G -->|stub| F
  G -->|live| H{trial-derived coverage >= minTasks}
  H -->|short| F
  H -->|ok| I{k distinct trialIndex per task}
  I -->|padded / missing| F
  I -->|ok| J{derived passK == reported}
  J -->|mismatch| F
  J -->|match| K{passK >= minPassK}
  K -->|below| F
  K -->|meets| L{silentCorruptions == 0}
  L -->|any| F
  L -->|zero| P[PASS: floor enforced]
  E -->|minPassK == 0, no artifact| N[note: dormant floor]
```
