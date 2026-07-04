# D4 — Computer-use API surface (ground-truthed from live docs, 2026-07)

Pinned from Anthropic's public computer-use tool documentation. Use these EXACT
strings in `agent/model.ts`. Variants are rejected.

## Tool definition (model-facing)

```json
{
  "type": "computer_20251124",
  "name": "computer",
  "display_width_px": 1280,
  "display_height_px": 800,
  "display_number": 1
}
```

- Beta header: **`computer-use-2025-11-24`** — call via `client.beta.messages.create(..., betas: ["computer-use-2025-11-24"])`.
- **Model support (from the doc's beta note):** Sonnet 5, **Opus 4.8**, Opus 4.7,
  Opus 4.6, Sonnet 4.6, Opus 4.5. **Claude Fable 5 is NOT listed** for the
  computer-use tool. Therefore:
  - **Default CUA model = `claude-opus-4-8`** (top listed, top listed).
  - `claude-fable-5` is selectable but **flagged unverified for computer use** —
    `model.ts` must not silently assume it works; if configured, attempt and
    surface any 400 clearly (do not claim support in docs).

## Model-emitted actions (in `tool_use.input.action`)

Coordinates are `"coordinate": [x, y]` **arrays**. Action names:
`screenshot`, `left_click`, `right_click`, `middle_click`, `double_click`,
`triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`,
`left_mouse_up`, `type` (`text`), `key` (`text`), `hold_key` (`text`,
`duration`), `scroll` (`coordinate`, `scroll_direction`, `scroll_amount`),
`wait` (`duration`), `cursor_position`, `zoom` (needs `enable_zoom:true`).
Modifier keys during click/scroll: pass via the `text` param on that action.

## Translation to Maudslay's internal `CUAction`

`agent/loop.ts` maps the model action → internal `CUAction` (src/types.ts):
`left_click` → `{kind:"click", x, y}`; `double_click` → `{kind:"double_click"}`;
`type` → `{kind:"type", text}`; `key` → `{kind:"key", combo:text}`; `scroll` →
`{kind:"scroll", dx, dy}` (map direction+amount to dx/dy); `screenshot` →
`{kind:"screenshot"}`; `wait` → `{kind:"wait", ms: duration*1000}`. Unmapped
model actions (right_click, drag, zoom, cursor_position) → execute a best-effort
equivalent through the executor OR record as unsupported and continue. The
agent's own `escalate`/`done` are surfaced by instructing the model (system
prompt) to call the `escalate` / `done` custom tools defined alongside
`computer`, OR by a text convention parsed in loop.ts — pick the tool approach
(add two custom tools `escalate{reason}` and `done{summary}` to the request).

## tool_result screenshots

After executing an action, return a `tool_result` for the `tool_use_id` whose
content is an image block (base64 PNG of the current viewport) — this is the
next observation. Include a short text note only when an action was blocked by
the sandbox (so the model can adapt).

## Refusal / fallback (only relevant if Fable 5 is ever wired)

Opus 4.8 has no refusal-classifier fallback concern for this path. If Fable 5 is
attempted: omit `thinking`, include `betas: ["server-side-fallback-2026-06-01"]`
+ `fallbacks:[{model:"claude-opus-4-8"}]` when `fallbackToOpus`, and check
`stop_reason === "refusal"` before reading content. No temperature/top_p/top_k.
Effort via `output_config: { effort }`.

## Prompt-injection note (security-relevant, from the doc)

The computer-use classifiers may auto-insert user-confirmation steps when they
detect injection in screenshots. Our sim serves hostile-but-controlled content;
`SECURITY.md` must document that the sandbox's `data-guard` approval gate is the
primary defense and does not depend on the model's own classifier.
