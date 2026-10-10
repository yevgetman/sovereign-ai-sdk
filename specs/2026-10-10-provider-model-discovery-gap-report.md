# SDK and SOV provider/model selection — formal gap report

**Assessment date:** 2026-10-10. **Status:** findings and issue decomposition; no implementation or release is claimed.

## Executive assessment

The SDK and SOV implement multiple inference transports. The principal gap is a
shared, current, model-aware discovery contract across execution and presentation.
Expanding static menus alone would leave incorrect capability and limit reporting.

Grok is implemented through a direct xAI API-key lane (`xai`) and a distinct
subscription adapter (`grok`). Implementation is not proof that a particular
subscription tier or account can make a successful request. The six explicit
routes are OpenRouter, Anthropic, OpenAI and xAI API routes plus ChatGPT and Grok
subscriptions. Claude-Max HTTP is deliberately refused. Other SDK transports,
including local Ollama/SOV and Manifest routing, exist outside this six-route
catalog. Subscription access is opt-in and must retain local-owner boundaries.

## Scope and method

Reviewed source master `f2b59e617e4c4a220428a53e194b5062e52358d5`; GitHub's API
confirmed that head. Queried the installed SOV **0.6.76** version and its read-only
`routes --json` contract. Ran pure local route-validation/request-construction
probes without inference. Compared results with public OpenRouter metadata and
publisher documentation. Related Telekit/Mac source was inspected to assign
follow-up ownership, not to certify deployed UI behavior.

No paid inference, credential reads, daemon restart, installed upgrade, active
turn interruption or model/default configuration change was performed. The
OpenRouter GET returned **458 text-output model IDs across 62 author prefixes**
in this snapshot. That is not every OpenRouter endpoint, account entitlement or
an agent-compatibility certificate. SDK Git HTTPS ls-remote timed out; the separate
GitHub API confirmed the inspected SHA.

## Selection semantics

| Concept | Meaning | Selection use |
|---|---|---|
| Harness | Execution application, such as SOV or Claude Code | Host chooses the harness |
| Route | Transport/provider plus authentication/payment identity | SOV selects an explicit route |
| Model author | Organization named in an OpenRouter model prefix | Groups the OpenRouter model menu |
| Model ID | Exact backend request identifier | Stored and sent verbatim |
| Inference host | Actual provider/endpoint serving an OpenRouter request | Optional advanced routing policy |
| Capability | Tools, modalities, effort and context/output limits | Validated for model and transport |

After selecting SOV, direct navigation is **route → model**. OpenRouter navigation
is **route → author → model**. The author grouping is a view over `author/model`
IDs; it is not another credential route. The inference host is separate from the
author and should not be conflated with that grouping. API keys and subscription
authentication must remain distinguishable even when they serve a similar model.

## Evidence and observed gaps

| Observation | Current source/CLI result | Compared evidence | Consequence |
|---|---|---|---|
| Catalog coverage | OpenRouter route lists four suggestions; modelsAuthoritative is false | Public snapshot contains 458 text-output IDs | Menu cannot describe the available space |
| Internal consistency | SDK OpenAI route includes gpt-5; SOV config does not | Separate tables in three source surfaces | UI changes drift independently |
| Unknown model IDs | Sonnet4.6 via OpenRouter and GPT5.5 direct pass local selection | Both IDs absent from their route suggestions | Missing menu entry does not mean execution is blocked or verified |
| Reasoning | high rejected for direct Grok4.6 and OpenRouter Grok4.6/KimiK2.5 | Publisher/catalog metadata advertises reasoning controls | Choices and adapter controls are incomplete |
| Context limits | Direct Grok128K; routed Grok200K; routed Sonnet4.6 200K | Publisher/catalog500K,500K,1M respectively | Can reduce usable context prematurely; unknown small models can also exceed assumptions |
| Input capability | All OpenRouter models inherit route-level image support; direct xAI denied | No per-model OpenRouter vision check; Grok publisher advertises images/tools | Menus can permit incompatible input or hide usable capabilities |
| Cost metadata | Small static price table; unknown pricing helper defaults to zero | Combined-context path guards unknown pricing, historical no-context path does not universally guard it | An estimate can imply free usage when the rate is unknown |
| Host selection | Standard OpenRouter request body lacks a provider routing object | Documented order/only/ignore/fallback controls exist | Exact host/policy cannot be represented through the standard adapter |
| Host integration | SOV exposes versioned static routes; host source has separate menus/rules | No shared full model/capability discovery contract | UI and execution need the same authoritative input |

These are source/contract findings. A metadata-supported parameter still needs
an adapter-specific mapping and serializer verification. In particular, API
reasoning/image support does not prove support on the subscription endpoint.
`off` may mean no requested control rather than a verified reasoning disable.
A provider's maximum context is also not a safe deployment budget: explicit host
caps, output headroom and context-management policy must still apply.

## Gap register and individual issues

Priority **P1** means correctness or a foundation required by the selection path.
Priority **P2** means completeness, truthful reporting or dependent UI/policy work.
These are planning priorities, not claims that every gap is an exploitable defect.

| Gap | Repository / work item | Priority | Dependencies |
|---|---|---|---|
| G1 | sovereign-ai-sdk — [G1: Define a portable SDK model catalog and capability contract](https://github.com/yevgetman/sovereign-ai-sdk/issues/24) | P1 | None |
| G2 | sovereign-ai-sdk — [G2: Discover OpenRouter agent models and cache their capability metadata](https://github.com/yevgetman/sovereign-ai-sdk/issues/25) | P1 | G1 |
| G3 | sovereign-ai-sdk — [G3: Discover direct-provider models and keep subscription availability separate](https://github.com/yevgetman/sovereign-ai-sdk/issues/26) | P1 | G1 |
| G4 | sovereign-ai-sdk — [G4: Make reasoning effort model-aware for direct xAI and OpenRouter models](https://github.com/yevgetman/sovereign-ai-sdk/issues/27) | P1 | G1 |
| G5 | sovereign-ai-sdk — [G5: Resolve context and output limits from model metadata at turn start](https://github.com/yevgetman/sovereign-ai-sdk/issues/28) | P1 | G1, G2, G3 |
| G6 | sovereign-ai-sdk — [G6: Validate image and tool support for the selected model and route](https://github.com/yevgetman/sovereign-ai-sdk/issues/29) | P1 | G1, G2, G3 |
| G7 | sovereign-ai-sdk — [G7: Report unknown model pricing honestly and retain pricing provenance](https://github.com/yevgetman/sovereign-ai-sdk/issues/30) | P2 | G1, G2, G3 |
| G8 | sovereign-ai-sdk — [G8: Add typed OpenRouter inference-host and fallback policy controls](https://github.com/yevgetman/sovereign-ai-sdk/issues/31) | P2 | None |
| G9 | sovereign-ai-sdk — [G9: Expose versioned SOV model discovery for Telekit and Kernel consumers](https://github.com/yevgetman/sovereign-ai-sdk/issues/32) | P1 | G1, G2, G3 |
| G10 | sovereign-ai-sdk — [G10: Use one model catalog across SOV configuration and model pickers](https://github.com/yevgetman/sovereign-ai-sdk/issues/33) | P2 | G1, G9 |
| G11 | telekit — [G11: Consume SOV model discovery in route-scoped Telegram selection](https://github.com/yevgetman/telekit/issues/30) | P2 | G4, G9 |
| G12 | kernel-installer — [G12: Consume SOV route and model discovery in Kernel Mac agent settings](https://github.com/yevgetman/kernel-installer/issues/176) | P2 | G4, G8, G9 |

### G1 — Define a portable SDK model catalog and capability contract

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P1. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/24.

**Evidence:** RouteRecord has model IDs and effort hints but no model-author identity, context/output limits, per-model tool/image capabilities or discovery freshness. listRoutes() is a pure static function and modelsAuthoritative is false.

**Bounded deliverable:** Add the shared typed contract and injectable discovery/cache ports. Keep transport/provider, model author, inference host, authentication and model ID distinct. Other issues implement adapters and consumers.

**Close criteria:**

- Define exact model ID, display name, author, route/auth identity, capability support as supported/unsupported/unknown, context/output limits, effort choices and metadata source/fetched-at/stale state.
- Provide explicit discovery and injectable cache/fetch; preserve the SDK no-disk default, Node >=20.19.0 and Bun >=1.2.0 support.
- Keep listRoutes()/sov routes discovery offline unless a separate explicit refresh is requested. Never read arbitrary host credentials or initialize subscription login during catalog enumeration.
- Preserve non-authoritative fallback and caller-supplied model IDs. Public catalog presence must not imply account entitlement or verified inference.
- Provide packed Node/Bun contract tests, schema/version migration guidance and fixtures for unknown metadata.

### G2 — Discover OpenRouter agent models and cache their capability metadata

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P1. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/25.

**Evidence:** The route suggests four OpenRouter IDs. A read-only public models request on 2026-10-10 returned 458 text-output IDs across 62 author prefixes, including Sonnet4.6, Opus4.7, GPT5.5 and Grok4.6.

**Bounded deliverable:** Implement the OpenRouter discovery adapter and metadata normalization; do not change execution defaults or add a UI here.

**Close criteria:**

- Fetch the documented models API, handle pagination, and normalize exact IDs, authors, limits, tools/images/reasoning support and price metadata.
- Distinguish text-output agent candidates from embeddings, audio-only and image/video-generation models. Public availability is not an account-level entitlement assertion.
- Support caller-injected cache with bounded timeout, refresh deduplication, TTL/fetched-at and explicit stale/unavailable states; stale metadata must not be presented as current.
- Retain user-entered IDs and cached/offline suggestions on discovery failure without silently selecting another model or payment route.
- Use bounded offline fixtures for multiple authors, model deletion, unknown fields, pagination and refresh failure. No paid inference is required.

### G3 — Discover direct-provider models and keep subscription availability separate

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P1. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/26.

**Evidence:** Native lists are static; openai-api suggests gpt-4o-mini/gpt-4o/gpt-5 while the SOV config menu omits even gpt-5. ChatGPT/Grok subscriptions have distinct adapters and are not equivalent to API-key access.

**Bounded deliverable:** Implement discovery sources for direct Anthropic/OpenAI/xAI routes and explicit subscription availability reporting. Unknown subscription discovery must stay unknown.

**Close criteria:**

- Use documented read-only provider model endpoints where available, scoped to explicitly authorized credentials; separate API and subscription catalogs.
- Resolve configurable aliases to exact request IDs while retaining user choices and unchanged defaults.
- Report verified account availability separately from provider-advertised metadata; mark missing discovery interfaces unknown rather than copying the API list into subscription routes.
- Do not add Claude-Max HTTP support: the existing explicit refusal remains intact. Keep custom/local provider injection possible without claiming the six built-in routes exhaust all SDK transports.
- Test credential isolation, offline fallback, stale/deleted IDs and API/subscription separation with fixtures.

### G4 — Make reasoning effort model-aware for direct xAI and OpenRouter models

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P1. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/27.

**Evidence:** Local route probes reject high effort for direct grok-4.6, OpenRouter x-ai/grok-4.6 and listed moonshotai/kimi-k2.5. Grok/Kimi catalog metadata advertises reasoning; current support is inferred from a short name-regex allowlist.

**Bounded deliverable:** Align route validation, advertised effort choices and outbound transport parameters for each verified model/route.

**Close criteria:**

- Use model metadata plus verified adapter-specific mappings instead of a name-only gate; advertise only effort values that the selected transport honors.
- Cover direct xAI and OpenRouter Grok/Kimi separately; subscription support must be verified independently and remain conservative if unproved.
- Distinguish off/no-control from a verified reasoning-disable operation; never silently drop an explicitly accepted effort value.
- Preserve structured effort_unsupported errors for unsupported/unknown selections and stable behavior for existing Anthropic/OpenAI models.
- Test the exact request body, route choices and rejected levels with offline fixtures. Any live validation needs separate spend/access approval and recorded evidence.

### G5 — Resolve context and output limits from model metadata at turn start

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P1. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/28.

**Evidence:** Pure probes resolve direct Grok4.6 to128K, OpenRouter Grok4.6 to200K and OpenRouter Sonnet4.6 to200K. Publisher/catalog metadata advertises500K,500K and1M respectively. MODEL_CONTEXT uses a short static table and provider fallback.

**Bounded deliverable:** Feed model-specific limits into turn budgeting and context management without claiming provider context maxima are deployment-safe budgets.

**Close criteria:**

- Resolve effective context/output limits for the exact route/model and record metadata provenance; separate provider maxima from explicit host/config caps.
- Apply the smallest verified effective limit, accounting for output reservation, system/tools/history and context-port accounting.
- Recompute limits on model/route changes and resume; reject or use the approved context-management policy rather than dropping history.
- Use a documented conservative unknown fallback. Preserve explicit host limits and no-disk behavior.
- Test Grok/Sonnet metadata mismatches, small-window models, missing/stale limits, resume changes and output headroom.

### G6 — Validate image and tool support for the selected model and route

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P1. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/29.

**Evidence:** ROUTE_IMAGE_SUPPORT advertises images for every OpenRouter model and denies direct xAI images. The code explicitly says per-model OpenRouter vision is not checked; direct Grok4.6 publisher metadata advertises image input and function calling.

**Bounded deliverable:** Validate agent-required tools and actual input modalities per model as well as per transport; verify xAI image serialization before enabling it.

**Close criteria:**

- Expose supported/unsupported/unknown tools and input modalities in the catalog; distinguish metadata claims from verified serializer support.
- Reject incompatible input before inference with stable safe errors; text-only OpenRouter choices must not inherit route-wide image support.
- Implement and fixture-test direct xAI image transport if supported by the current API, then advertise it; keep subscription paths independently fenced.
- Permit appropriate text-only/no-tool runs without pretending every OpenRouter endpoint can execute an agent workflow.
- Test mixed-modality history, route/model switches, missing capability metadata and unsupported tool-choice formats.

### G7 — Report unknown model pricing honestly and retain pricing provenance

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P2. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/30.

**Evidence:** PRICE_TABLE is small and estimateCostUsd falls back to zero for unknown models. createAgent has an unknown-price guard for combined context accounting, but the historical no-context path can still return a zero estimate for an unpriced paid model.

**Bounded deliverable:** Consume discovered or injected rates and distinguish unknown estimates from verified zero cost. This is estimation, not a billing-provider integration.

**Close criteria:**

- Represent known paid, verified free/local, subscription/quota and unknown pricing distinctly; unknown paid models must not be displayed or aggregated as zero dollars.
- Preserve token usage when price is unknown and expose completeness/source/time/version of estimates; audit affected return, persistence and CLI cost surfaces.
- Normalize per-token/per-million and cached-token rates; do not double-count reasoning tokens or confuse provider usage with the full delegated bill.
- Keep historical usage tied to its recorded pricing snapshot; refreshed rates must not silently reprice old records.
- Add additive/deprecation guidance where existing numeric APIs require compatibility, with regressions for unknown direct/OpenRouter models and context+child aggregation.

### G8 — Add typed OpenRouter inference-host and fallback policy controls

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P2. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/31.

**Evidence:** OpenRouter documentation supports provider order/only/ignore and fallback controls. The standard OpenAIProvider OpenRouter body has no provider routing object; vendor/model identifies the model author, not the inference host.

**Bounded deliverable:** Expose a typed optional OpenRouter execution policy in the SDK and thread it through SOV configuration. Keep current default behavior unchanged.

**Close criteria:**

- Support validated inference-host selection/order and fallback policy, plus relevant capability/privacy constraints where supported by the documented API.
- Serialize the OpenRouter provider object only for its transport; never leak policy fields into native Anthropic/OpenAI/xAI requests.
- Preserve an explicitly pinned host and disabled-fallback policy; never silently widen host, model, authentication or payment choices.
- Treat model author and host/endpoint identity as separate fields. Report actual host only when response evidence supplies it; otherwise report unknown.
- Test exact request bodies, unavailable pinned hosts, rejected policy and unchanged default requests with fixtures.

### G9 — Expose versioned SOV model discovery for Telekit and Kernel consumers

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P1. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/32.

**Evidence:** sov capabilities/routes --json expose schemaVersion1 and static model lists. They do not expose a complete searchable model catalog or per-model limits/capability freshness.

**Bounded deliverable:** Add a stable CLI machine discovery surface backed by the SDK catalog, separate from inference and from host UI.

**Close criteria:**

- Expose route-scoped model records through versioned JSON with filtering/search/pagination and explicit refresh/freshness modes.
- Keep existing capabilities/routes flags and offline semantics backward compatible; advertise the new discovery capability for binary-version negotiation.
- Return bounded output and structured safe errors; never include credential values, refresh subscription tokens or perform inference to build a menu.
- Document how older binaries and stale/offline catalogs degrade while preserving persisted route/model IDs.
- Test compiled/source CLI output, schema compatibility, malformed/unavailable catalogs and Node/Bun portable contract consumption.

### G10 — Use one model catalog across SOV configuration and model pickers

**Owner repository:** `yevgetman/sovereign-ai-sdk`. **Priority:** P2. **Issue:** https://github.com/yevgetman/sovereign-ai-sdk/issues/33.

**Evidence:** Model lists are independently maintained in packages/sdk/src/providers/routes/catalog.ts, src/config/catalog.ts and src/commands/pickers.ts. Their OpenAI suggestions already disagree.

**Bounded deliverable:** Replace duplicate SOV model suggestion lists with shared catalog consumers; retain curated presentation as a view rather than a separate authority.

**Close criteria:**

- Use provider/auth route→model for direct choices and OpenRouter→author→model for the routed catalog; inference-host policy stays a separate advanced choice.
- Support search, current selection, custom IDs, stale/offline notices and model capability/effort details; do not flatten all routes into ambiguous aliases.
- All SOV config, REPL/TUI picker and lane model suggestions agree on IDs and capabilities for the same catalog snapshot.
- Do not silently switch credentials/provider/model on resume or when a selected model disappears; require an explicit replacement choice.
- Add menu/command consistency and persistence regressions; keep CLI help and operator documentation aligned.

### G11 — Consume SOV model discovery in route-scoped Telegram selection

**Owner repository:** `yevgetman/telekit`. **Priority:** P2. **Issue:** https://github.com/yevgetman/telekit/issues/30.

**Evidence:** Telekit routing PR29 is already merged (0fe28a87b8b91551cef0aaa5718da1bc75e0b4f4). Its route model contract consumes SOV lists while host code also carries legacy aliases/provider-scope rules. The installed per-chat explicit-route versus legacy state was not certified by this SDK investigation.

**Bounded deliverable:** Audit the actual installed binary/chat route mode, then integrate the new SOV discovery contract. This is a host follow-up after the SDK/CLI surface exists.

**Close criteria:**

- Record installed Telekit/SOV versions, resolved binaries and selected route mode before declaring the existing UI defect reproduced or fixed.
- Provide direct route→model and OpenRouter route→author→model navigation with search/pagination and visible route/auth/effort/current model.
- Use SOV metadata and structured validation for explicit routes instead of maintaining another authoritative model/effort allowlist; retain safe legacy fallback for older binaries.
- Preserve per-chat saved choices, alias migrations, auth boundaries and payment routes. Handle stale catalogs and unavailable models without silent fallback.
- Verify Telegram-facing messages and command round trips with fixtures; add a controlled end-to-end test at the actual deployed versions without interrupting active turns.

### G12 — Consume SOV route and model discovery in Kernel Mac agent settings

**Owner repository:** `yevgetman/kernel-installer`. **Priority:** P2. **Issue:** https://github.com/yevgetman/kernel-installer/issues/176.

**Evidence:** Source src/providers.ts curates Anthropic/OpenAI/OpenRouter and src/models.ts maintains native presets while OpenRouter uses free text. This is a local source observation, not a claim about the installed app version.

**Bounded deliverable:** Integrate the new SOV machine contract into Mac settings and gateway configuration; verify installed behavior separately and coordinate any shared runtime work with kernel-dev.

**Close criteria:**

- Resolve bundled/installed SOV version and advertised discovery capability; load supported routes and preserve a compatible fallback for older bundles.
- Show direct provider/auth→model and OpenRouter→author→model with searchable choices, limits, tool/image/effort support and freshness.
- Expose xAI API only after credential-environment/gateway plumbing is verified; subscription routes require their existing explicit local-owner credential policy.
- Thread exact route/model/effort and optional OpenRouter host policy into launches; report effective selections and never silently alter saved credentials or payment routes.
- Test frontend/backend agreement, source/bundled SOV version skew, offline discovery, persistence and fresh-install safety. A source merge is not an installed Mac release.

## Sequencing and release boundaries

Land G1 first. OpenRouter discovery (G2), direct-route discovery (G3), reasoning
work (G4) and the independently typed host policy (G8) can proceed on separate
branches after their declared prerequisites. Limits, input validation and pricing
consume their shared metadata, while CLI discovery supplies the host interface.
SOV pickers, Telekit and Mac integration then use that same interface.

Each issue has one deliverable and independent close criteria. The register lists
cross-repository dependencies explicitly. The SDK production issue15 remains a
separate umbrella for deployment/operating-envelope and merge-rule work; these
issues do not close it by implication. The Mac issue owns settings integration;
any necessary Kernel runtime/gateway backend change must be coordinated with
kernel-dev and tracked there rather than silently implemented in the SDK.

The old Telekit handoff is stale: routing PR29 is **merged**, at
`0fe28a87b8b91551cef0aaa5718da1bc75e0b4f4`, on2026-10-09. Its installed version,
selected route mode and actual menu behavior require a fresh host-side check.
The main local SDK/Telekit seats also contain older or unrelated work; treat
pinned source and installed binaries as separate evidence.

The active SDK0.13.1 / CLI0.6.77 draft currently selects PR23's diagnostic fixes.
These newly filed issues are **unimplemented** and do not enter a release roster
until their completed reviewed source units are deliberately selected. No release
version, consumer pin, publication authority or installation is changed here.

## Verification required for closure

Use deterministic offline catalog/transport fixtures, packed Node/Bun contracts,
CLI schema/compatibility checks and human-visible menu/message checks. Cover exact
request IDs and parameters, stale/missing/deleted metadata, account/route isolation,
model changes on resume and preserved history. Live checks need an agreed access
and spend boundary and must record their exact model, route and software version.
Do not report universal model support from a static list or mocked transport.

## Source references

- [SDK route catalog](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/packages/sdk/src/providers/routes/catalog.ts)
- [SDK route validation](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/packages/sdk/src/providers/routes/validate.ts)
- [SDK provider/context registry](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/packages/sdk/src/providers/models.ts)
- [SDK effort mapping](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/packages/sdk/src/providers/effort.ts)
- [SDK OpenRouter request construction](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/packages/sdk/src/providers/openai.ts)
- [SDK pricing helper](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/packages/sdk/src/providers/pricing.ts)
- [SDK cost aggregation](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/packages/sdk/src/agent/createAgent.ts)
- [SOV configuration model lists](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/src/config/catalog.ts)
- [SOV picker lists](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/src/commands/pickers.ts)
- [SOV machine route discovery](https://github.com/yevgetman/sovereign-ai-sdk/blob/f2b59e617e4c4a220428a53e194b5062e52358d5/src/cli/routesCommands.ts)
- [OpenRouter model metadata API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
- [OpenRouter inference-host routing](https://openrouter.ai/docs/guides/routing/provider-selection).
- [xAI Grok4.6 capabilities](https://docs.x.ai/developers/models/grok-4.6).
- [Merged Telekit route integration PR29](https://github.com/yevgetman/telekit/pull/29).
- [Kernel Mac model presets](https://github.com/yevgetman/kernel-installer/blob/main/src/models.ts) and [provider metadata](https://github.com/yevgetman/kernel-installer/blob/main/src/providers.ts); these mutable links locate related source rather than prove installed state.
