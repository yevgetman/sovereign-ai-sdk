# M11.5 — Real-Anthropic picker smoke (2026-05-19)

Captured by `tests/parity/m11_5PickerSmoke.test.ts` when env-gated by `SOV_M11_5_REAL_SMOKE=1`.

## Scenarios

| Agent | Dispatch | Expected envelope shape |
|---|---|---|
| A | `POST /sessions/<id>/commands { name: 'model' }` (no args) | `output: '' + sideEffects.pickerOpen { title, items[3], onSelect: { command: 'model' } }` |
| B | `POST /sessions/<id>/commands { name: 'model', args: 'claude-sonnet-4-6' }` | `output: 'model set to …' + sideEffects.modelChanged: 'claude-sonnet-4-6'` |

## Outcome

**2/2 pass, 0 fail, 13 expect() calls in ~502 ms.**

- `agent-a-pickeropen.json` — the picker payload emitted by `/model` no-args. Items: haiku-4-5 (current), sonnet-4-6, opus-4-7. `initial=0` matches the current model.
- `agent-b-modelchanged.json` — the success envelope from `/model claude-sonnet-4-6`. Confirms the dispatcher's existing `modelChanged` side-effect (M10.5) continues to fire on the explicit-arg path, with no `pickerOpen` collision.

## Cost

Effectively zero. The `/model` slash command runs entirely server-side in the registry; no LLM inference is invoked. The Anthropic provider is constructed but not called.

## Why real instead of mock

The mock-provider unit tests cover the same wire shape, but they exercise a runtime that doesn't load the full Anthropic preflight code path. This smoke verifies the dispatcher and the picker envelope remain compatible with a real Anthropic-backed runtime — catches drift between `src/server/schema.ts` (Zod-side) and the provider construction code.
