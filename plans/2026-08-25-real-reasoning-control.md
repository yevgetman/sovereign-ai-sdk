# Real reasoning control — implementation plan

Spec: `specs/2026-08-25-real-reasoning-control-design.md` (green-lit 2026-08-25).
Gate: `bun run typecheck && bun test && bun run lint` (sov); `npm run -s typecheck && npx vitest run` (appleo).

- [ ] **A — provider** (`packages/sdk/src/providers/effort.ts`, `providers/openai.ts`,
  `tests/providers/effort.test.ts`, `tests/providers/openai.test.ts`): `off` ⇒ explicit
  `reasoning: { enabled: false }` on the openrouter lane for gated models; undefined ⇒ omitted.
  Type of `OpenAIChatBody.reasoning` widened to `{ effort } | { enabled: false }`.
- [ ] **B — gateway per-turn effort** (`packages/protocol/src/endpoints.ts`,
  `src/server/routes/turns.ts`, new `tests/server/turns.effort.test.ts`): boundary validation
  (400 on invalid), `perTurnEffort ?? sessionCtx.effort` into PerTurn.
- [ ] **C — appleo** (`src/config/config.ts`, `src/agent/gateway/contract.ts`, `client.ts`,
  `src/tailor/run-service.ts`, `src/http/platform-app.ts`, `.env.example`, tests):
  `AGENT_TAILOR_EFFORT` default `off`; tailor turn posts `effort`.
- [ ] **D — docs**: sov CHANGELOG 0.6.71 (+ sdk 0.10.1), `docs/03-cli-reference/usage.md`
  (turn body `effort`; `off` is a real disable on openrouter), version bumps.
- [ ] **E — gate + ship**: sov gate green, commit per task, push; build linux-arm64; appleo
  gate green, commit, push, deploy via `SOV_LOCAL_BIN=sov-local`; verify a tailor trace.
  Stage release v0.6.71 for the CEO.
