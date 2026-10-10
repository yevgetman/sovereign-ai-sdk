# Resilient SDK and SOV model discovery

Implement SDK issues #24–#33 as separately reviewable dependent PRs. Preserve exact route/auth/model identity, opt-in subscription boundaries and unchanged defaults. No merge, release or installed upgrade is part of this request.

The SDK owns portable versioned model records, discovery/cache ports and immutable provenance. Catalog refresh is explicit and bounded. Unknown support is not unsupported; advertised support is not account entitlement or verified serializer support. New provider fields and model IDs must survive without model-family allowlists. Host limits constrain provider limits. Stale data may tighten limits but must not expand them. Persist selected IDs even when a catalog deletes them.

Dependency sequence: #24 contract; #25 OpenRouter and #26 direct/subscription discovery; #27 effort mapping; #28 limits and #29 modalities; #30 pricing snapshots; #32 machine discovery then #33 shared menus. Independent #31 inference-host policy can proceed in parallel. Root integrates and checks all heads, then publishes each issue PR with explicit bases and dependencies. Telekit #30 and Mac #176 remain separate host tasks outside this SDK/SOV request.

Checks: offline injected metadata/transport fixtures, malformed/stale/unavailable/account-isolation tests, exact request parameters, selection/resume consistency, unknown-price persistence, configured lint/types/full suite, packed SDK Node/Bun canary and compiled CLI discovery. No paid inference or credential exposure.

Cross-references: `specs/2026-10-10-provider-model-discovery-gap-report.md`; `plans/2026-10-10-resilient-model-discovery.md`; `packages/sdk/src/providers/models/README.md`; `docs/03-cli-reference/sdk-routes.md`.
