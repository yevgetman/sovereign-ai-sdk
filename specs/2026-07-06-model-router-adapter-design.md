# Spec — Model-router adapter: a thin router lane, Manifest as the current solution

- **Date:** 2026-07-06
- **Author:** Julie (Gene's AI assistant), from source analysis of sov master (`3e192cb`) and the
  Manifest docs (manifest.build/docs, fetched 2026-07-06)
- **Status:** CEO green-lit spec+build in one directive (2026-07-06 session): "let's do the work on
  the SDK to add the adapter, then let's wire up Manifest as the current router solution … update
  documentation … work in a separate git branch." The design choices below (thin adapter on the
  OpenAI-compatible surface + a routing-hint header seam; Manifest as the current binding) were
  ratified by the CEO in the same session. This spec records the design; no further gate.
- **Driver:** the Factory's **model-router organ** (`~/code/me/projects/model-router.md`, committed
  2026-07-02): a dedicated, provider-agnostic router the SDK *connects to* but does not embed. The
  adopt-vs-build decision resolved to **adopt [`mnfst/manifest`](https://github.com/mnfst/manifest)
  as the current router solution** (CEO, 2026-07-06), with the SDK-side seam kept generic so the
  router stays swappable — the same protocol-marriage posture as the Assay wire
  (`specs/2026-07-05-assay-integration-design.md`).

## 1. Summary

Add a **generic model-router provider lane** to the open SDK: a new `RouterProvider` transport
(apiMode `'router'`) that speaks to any OpenAI-compatible model-routing proxy, plus a **`manifest`
registry lane** binding it to Manifest as the *current, official* router solution. The caller stops
choosing a model — it asks the lane for `"auto"` and the router picks the upstream
(cost/capability/locality/subscription-vs-API/fallbacks are the router's job, per the organ doc).

The adapter is thin by design:

- **Transport reuse.** Manifest exposes `POST /v1/chat/completions` in OpenAI format with SSE
  streaming and verbatim tool passthrough — exactly what `OpenAIProvider` already speaks. The
  adapter subclasses it (the `SovProvider` precedent) and overrides only the seams that differ.
- **The routing-hint seam = HTTP headers.** Manifest routes by complexity/specificity and by
  **custom tier headers** (user-defined key/value pairs configured in Manifest); `x-session-key`
  groups requests for sticky-upstream/prompt-caching. The adapter carries a static
  `headers` map so any of these can be sent without new SDK concepts.
- **Route visibility.** Manifest reports what it actually did in response headers
  (`X-Manifest-Model`, `X-Manifest-Provider`, `X-Manifest-Tier`, `X-Manifest-Reason`). The adapter
  surfaces these through an opt-in `onRouteResolved` callback — the "report faithfully" seam — via
  one new protected `onResponse` hook on `OpenAIProvider` (default no-op).
- **No code dependency.** Nothing from Manifest is imported. The coupling is the OpenAI-compatible
  wire + the pinned header names in §4. Swapping routers later = a new registry entry (or a
  `baseUrl` override) on the same `RouterProvider`.

One sentence: *after this feature, any sov surface or `createAgent` embedder can set
`defaultProvider: "manifest"` (model `auto`) and every model call is routed by a self-hosted
Manifest instance — with tier hints, session stickiness, and the routed model reported back — while
the SDK remains router-agnostic.*

## 2. Current state (verified)

- **Provider layer (`packages/sdk/src/providers/`):** `ApiMode = 'anthropic' | 'openai' | 'ollama'
  | 'sov'`; `PROVIDER_REGISTRY` (models.ts) maps lane name → apiMode/defaultModel/defaultBaseUrl/
  authEnvVar/contextLength; `resolveProvider()` (resolver.ts) is the single assembly path for every
  surface (CLI/gateway/cron/API server/`createAgent` string-provider); `OpenAIProvider` exposes
  protected seams `requiresApiKey` / `defaultName` / `defaultBaseUrl` / `requestHeaders` (the
  `SovProvider` pattern: subclass + override only the deltas). `openrouter` already rides
  `apiMode: 'openai'` as a pure registry entry.
- **No router lane exists.** The harness's legacy `router.*` config block is **task routing**
  (in-harness lane-picking between configured providers) — a different, partially-built thing the
  model-router organ explicitly supersedes (`projects/model-router.md` § Boundaries). It is NOT
  touched by this build.
- **Manifest wire (docs, fetched 2026-07-06):**
  - Base URLs: self-hosted `http://localhost:2099` (Docker; `install.sh` one-liner), cloud
    `https://app.manifest.build`.
  - Endpoints: `POST /v1/chat/completions` (OpenAI), `POST /v1/messages` (Anthropic),
    `POST /v1/responses`, `GET /v1/models`.
  - Auth: `Authorization: Bearer mnfst_<key>` on every request (keys minted in the Manifest
    dashboard, Agents page).
  - Auto-routing: `"model": "auto"`. Manifest reshapes between OpenAI/Anthropic formats before
    forwarding to the resolved provider.
  - Streaming: `"stream": true` → SSE in the request's protocol (OpenAI `data:` chunks for us).
    Fallback applies pre-first-chunk; mid-stream failures close without retry.
  - Tools: `tools` / `tool_choice` / `response_format` pass through verbatim.
  - Request headers: custom **tier headers** (user-defined key+value, set when creating a tier);
    `x-session-key` (sticky sessions / prompt caching).
  - Response headers: `X-Manifest-Tier`, `X-Manifest-Model`, `X-Manifest-Provider`,
    `X-Manifest-Reason`, `X-Manifest-Output-Modality`, `X-Manifest-Response-Mode`.
  - Rate limit: 429 (default 100 req/60s per agent, self-hosted configurable); 424 = fallback
    chain exhausted.

## 3. Scope

**In:** the generic `RouterProvider` + the `onResponse` seam (§5 R1–R2); the `manifest` registry
lane + config schema + resolver threading (§5 R3–R5); honest effort gating (§5 R6); barrel exports
+ surface bump (§5 R7); wrapper `/config` catalog exposure (§5 R8); docs naming Manifest the
current router solution (§5 R9); tests incl. an env-gated live test (§6).

**Out (explicit non-goals):**

- **Per-session sticky-key threading.** Transports are session-agnostic; adding session identity to
  `ProviderRequest` is a core-type change. v1: `x-session-key` is settable as a static header
  (documented semantics: one key per process = one Manifest session — fine and cache-friendly for a
  single-user CLI). A per-session wire is a deferred follow-up.
- **Reasoning/effort passthrough.** With `model: "auto"` the upstream is unknown; sending
  `reasoning_effort` to a non-reasoning upstream errors. `modelSupportsReasoning(_, 'router')`
  returns **false** (the honest ollama-style gate); `/effort` is a documented no-op on this lane.
- **Spend tracking / limits / fallbacks.** Manifest's job (it has spend tracking, limits with
  alerts, and fallback chains). The SDK does not duplicate them on this lane.
- **The legacy `router.*` task-routing config.** Untouched; its eventual retirement in favor of the
  router organ is a separate decision.
- **Installing/operating Manifest on this machine.** The Docker install + dashboard key mint is an
  interactive, machine-state action — staged for the CEO (§8). The build proves the lane against
  scripted fetches + an env-gated live test.
- **Anthropic-format (`/v1/messages`) use of Manifest.** The lane rides the OpenAI wire only;
  Manifest reshapes upstream as needed.
- **OmniRoute or any second binding.** Watch-listed in `projects/model-router.md`; the generic
  class makes a future binding a registry entry.

## 4. The wire contract (pinned)

What the adapter assumes of a router (all verified true of Manifest today):

| Assumption | Manifest concretely |
|---|---|
| OpenAI Chat Completions at `<baseUrl>/chat/completions`, SSE streaming, tools verbatim | `http://localhost:2099/v1` + `/chat/completions` |
| Bearer auth | `Authorization: Bearer mnfst_<key>`, env `MANIFEST_API_KEY` |
| A routing alias model | `"auto"` (lane default) |
| Optional static routing-hint headers | tier headers (user-defined), `x-session-key` |
| Optional route-report response headers | `X-Manifest-Tier/-Model/-Provider/-Reason` |

Contract changes (header renames, alias changes) are Manifest-version concerns; the recipe doc
(§5 R9) pins the tested Manifest wire, and the env-gated live test (§6) is the conformance probe.

## 5. Work items

- **R1 — `RouterProvider`** in `packages/sdk/src/providers/router.ts` (new file).
  `class RouterProvider extends OpenAIProvider`, `apiMode: 'router'` (union extended in
  types.ts). Config = `OpenAIProviderConfig` + `headers?: Record<string, string>` (static
  routing hints) + `onRouteResolved?: (route: ResolvedRoute) => void`.
  `ResolvedRoute = { model?: string; provider?: string; tier?: string; reason?: string }`.
  Overrides: `defaultName() = 'router'`; `defaultBaseUrl() = 'http://localhost:2099/v1'` (the
  current solution's self-hosted default); `requestHeaders()` = custom headers merged FIRST, then
  `super`'s content-type/authorization applied on top (auth is never maskable by a hint header);
  `onResponse(res)` parses the `X-Manifest-*` headers and, when any is present, invokes
  `onRouteResolved` inside try/catch (a throwing callback must never break the turn — the
  `traceRecorder` posture). Key required (inherits `requiresApiKey() = true`; Manifest always
  requires `mnfst_`).
- **R2 — the `onResponse` seam.** One protected no-op method on `OpenAIProvider`:
  `protected onResponse(_res: Response): void {}`, called in `stream()` after the ok-check,
  before SSE parsing. Byte-identical behavior for every existing lane (no-op default) — the same
  minimal-seam discipline as the sov three-seam design.
- **R3 — the `manifest` registry lane.** `PROVIDER_REGISTRY.manifest = { provider: 'manifest',
  apiMode: 'router', defaultModel: 'auto', defaultBaseUrl: 'http://localhost:2099/v1',
  authEnvVar: 'MANIFEST_API_KEY', contextLength: 128_000 }`. The inline apiMode unions in
  models.ts / resolver.ts widen to include `'router'`. `contextLength` 128k is a deliberate
  conservative floor (the routed upstream is unknown; compaction math needs *a* number — document;
  pinning `providers.manifest.model` to a known model id restores exact context lookup).
- **R4 — config schema.** `providers.manifest` in `packages/sdk/src/config/schema.ts` using
  `RouterProviderConfigSchema = ProviderConfigSchema.extend({ headers:
  z.record(z.string()).optional() }).strict()` — `headers` exists ONLY on the router lane (no
  silent-no-op field on other providers).
- **R5 — resolver threading.** `providerConfigFor` gains the `manifest` branch;
  `instantiateTransport` gains the `apiMode === 'router'` branch instantiating `RouterProvider`
  (key required → `CredentialUnavailableError` when absent) and gains an optional `headers`
  parameter threaded from the lane config. `isKeylessProvider`: unchanged (manifest is keyed).
- **R6 — honest effort gate.** `modelSupportsReasoning`: `case 'router': return false` (documented
  v1 posture, mirrors ollama).
- **R7 — barrel + surface.** Export `RouterProvider`, `RouterProviderConfig`, `ResolvedRoute` from
  `packages/sdk/src/sdk.ts`; update `packages/sdk/tests/surface.test.ts` (additive);
  bump `@yevgetman/sov-sdk` 0.4.0 → **0.5.0** (names-frozen policy: additions = minor). Protocol
  package untouched. npm publish remains HELD (unchanged posture).
- **R8 — wrapper exposure.** `src/config/catalog.ts`: add `'manifest'` to `PROVIDER_CHOICES`, add a
  `providers-manifest` group (apiKey secret editor / model with `auto` default / baseUrl
  placeholder `http://localhost:2099/v1`), and a Providers-menu link — mirroring the openai group.
  Verify `providers.manifest.*` resolves to the live apply-scope like its siblings (prefix rule);
  add an exact entry only if the taxonomy needs it.
- **R9 — docs.** New recipe `docs/04-extending/routing-an-agent.md` ("Routing an agent through a
  model router — Manifest, the current official solution"): what the organ is (link the me-repo
  doc's framing), Manifest setup (Docker one-liner, dashboard key, `MANIFEST_API_KEY`), config
  (`defaultProvider: manifest`, model `auto`, tier headers, `x-session-key`), route visibility
  (`onRouteResolved` for embedders), honest caveats (effort no-op; conservative context floor;
  cost accounting: with `model: "auto"` the SDK's in-process `estimateCostUsd` and an Assay wire
  price the *alias*, not the routed model — Manifest's own spend tracking is authoritative on this
  lane; surfacing routed-model usage into the Assay wire is a named follow-up). Update the
  cli-reference provider list, `packages/sdk/README.md` provider mention, `CHANGELOG.md`,
  `docs/06-testing/testing-log.md`.

## 6. Testing

TDD per item. `tests/providers/router.test.ts` (scripted-fetch, the sov.test.ts pattern):
construction (name/apiMode/default baseUrl); missing-key throw; headers merge (tier header +
`x-session-key` sent; a malicious `authorization`/`content-type` in `headers` cannot mask the real
ones); `onRouteResolved` fires with parsed `X-Manifest-*` values; absent headers ⇒ no callback;
throwing callback swallowed, stream unaffected; SSE translation + tools + usage inherited (one
end-to-end scripted stream). Resolver tests: `resolveProvider('manifest')` registry defaults;
`MANIFEST_API_KEY` env credential; config `headers` threaded; missing key →
`CredentialUnavailableError`. Schema tests: `providers.manifest` accepted incl. `headers`; unknown
keys rejected; `headers` rejected on other lanes. Effort test: `modelSupportsReasoning('auto',
'router') === false`. Surface test updated. Plus `tests/providers/router.live.test.ts` — env-gated
(`MANIFEST_LIVE=1` + `MANIFEST_API_KEY`, skip otherwise; the sov.live pattern): one real `auto`
turn, asserts text + route headers observed.

Gate (every commit): `bun run lint && bun run typecheck && bun run test`.

## 7. Compatibility & posture

- **Additive only.** New class/file, one protected no-op hook, one registry key, one optional
  config block, barrel additions. Zero new dependencies. Every existing lane byte-identical.
- **Open-core boundary.** All SDK work is in the open package (`packages/sdk`) — the router seam is
  MIT territory like the Assay wire. The wrapper touch (catalog) is proprietary-side config UI.
- **Sovereignty.** Default endpoint is loopback self-hosted Manifest. Nothing calls out unless the
  operator points `baseUrl` at the cloud. Prompts flow through the router by definition (it's the
  request path) — self-hosting keeps them on-box; this is stated plainly in the recipe doc.
- **Swappability.** A future router (OmniRoute, native) = new registry entry riding the same
  `RouterProvider` (or a `baseUrl` override on an existing lane). The organ decision record stays
  in `~/code/me/projects/model-router.md`.

## 8. Staged for the CEO (not executed in this build)

1. **Install Manifest on this machine** (Docker one-liner + dashboard admin + mint an agent key
   into `MANIFEST_API_KEY`) — then run the live conformance test and a real routed session.
2. **Merge the `model-router-adapter` branch** (built + gated green + pushed; merge is the CEO's
   call per the branch directive).

## 9. References

- `~/code/me/projects/model-router.md` — the organ decision record (adopt Manifest, 2026-07-06)
- `specs/2026-07-05-assay-integration-design.md` — the protocol-marriage precedent
- `docs/specs/2026-06-08-sov-provider-design.md` — the subclass-seam precedent (Bucket A)
- Manifest docs: `manifest.build/docs/reference/api.md`, `…/reference/headers.md`,
  `…/routing.md`, `…/self-hosted.md`
