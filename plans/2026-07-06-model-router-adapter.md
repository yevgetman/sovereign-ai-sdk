# Plan — Model-router adapter (Manifest = current solution)

Spec: `specs/2026-07-06-model-router-adapter-design.md` (CEO green-lit 2026-07-06).
Branch: `model-router-adapter`. Gate at every commit: `bun run lint && bun run typecheck && bun run test`.
Subagent policy per `docs/05-conventions/subagent-policy.md` (Opus implementers; review between tasks).

## T1 — RouterProvider + the onResponse seam (spec R1, R2; tests §6)

Files: `packages/sdk/src/providers/types.ts` (ApiMode + `'router'`),
`packages/sdk/src/providers/openai.ts` (protected no-op `onResponse(res)` called in `stream()`
after the ok-check), `packages/sdk/src/providers/router.ts` (new),
`tests/providers/router.test.ts` (new, sov.test.ts pattern).
TDD: write router.test.ts first (construction, key-required, headers merge + auth-not-maskable,
onRouteResolved parse/absent/throwing-swallowed, inherited SSE/tools/usage end-to-end), then
implement. Commit: `feat(sdk): RouterProvider — generic model-router lane (apiMode 'router')`.

## T2 — the manifest lane (spec R3–R6)

Files: `packages/sdk/src/providers/models.ts` (registry entry + union widen),
`packages/sdk/src/providers/resolver.ts` (providerConfigFor branch, instantiateTransport 'router'
branch + headers threading, union widen), `packages/sdk/src/config/schema.ts`
(`RouterProviderConfigSchema` + `providers.manifest`), `packages/sdk/src/providers/effort.ts`
(`case 'router': return false`), tests: resolver/schema/effort additions.
Commit: `feat(sdk): manifest provider lane — Manifest wired as the current model router`.

## T3 — barrel + surface + version (spec R7)

Files: `packages/sdk/src/sdk.ts`, `packages/sdk/tests/surface.test.ts`,
`packages/sdk/package.json` (0.4.0 → 0.5.0).
Commit: `feat(sdk): export the router lane; bump sov-sdk 0.5.0 (additive)`.

## T4 — wrapper /config catalog (spec R8)

Files: `src/config/catalog.ts` (+ catalog test if present), apply-scope check
(`src/config/applyScope.ts` — expect the `providers.` prefix rule to cover `providers.manifest.*`;
add exact entries only if needed).
Commit: `feat(config): surface the manifest router lane in /config`.

## T5 — docs (spec R9)

Files: `docs/04-extending/routing-an-agent.md` (new recipe), cli-reference provider list,
`packages/sdk/README.md`, `CHANGELOG.md`, `docs/06-testing/testing-log.md`.
Plus `tests/providers/router.live.test.ts` (env-gated live conformance probe).
Commit: `docs: routing-an-agent recipe — Manifest as the current router solution` (+ `test(providers): env-gated manifest live probe`).

## T6 — close-out

Full gate green; push branch (NO merge — staged for the CEO per the branch directive);
update `~/code/me` (`projects/model-router.md` — adopt decision recorded as RESOLVED;
`projects/sovereign-ai-sdk.md` banner note) + memory + apex portfolio; report.
