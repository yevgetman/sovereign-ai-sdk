# Provider/model resilience — merged source work, planned release

**2026-10-10.** All ten SDK/SOV gap PRs #34–#43 are merged into master. The exact master merge commits are recorded in the SDK 0.14.0 draft manifest. This snapshot describes merged source, pending release. The published SDK remains **0.13.0** and SOV CLI/gateway remains **0.6.76**. No package release, installed upgrade or live-provider certification is claimed.

## Pull request dependency order

The PRs were reviewed in this dependency order, retargeted to master after each prerequisite merged, and merged with their reviewed heads unchanged. Merge commits preserve the full dependency ancestry. The repository does not automatically delete merged branches.

| Issue | Pull request | Completed scope |
|---|---|---|
| #24 | [#35](https://github.com/yevgetman/sovereign-ai-sdk/pull/35) | Portable exact-ID model catalog, explicit unknown evidence and freshness |
| #25 | [#36](https://github.com/yevgetman/sovereign-ai-sdk/pull/36) | Bounded OpenRouter discovery, validated metadata and route-scoped public cache |
| #26 | [#37](https://github.com/yevgetman/sovereign-ai-sdk/pull/37) | Account-scoped direct API discovery and subscription catalog boundaries |
| #27 | [#38](https://github.com/yevgetman/sovereign-ai-sdk/pull/38) | Evidence-based reasoning controls and future-model request shape |
| #28 | [#39](https://github.com/yevgetman/sovereign-ai-sdk/pull/39) | Dynamic context/output limits and conservative unknown/stale budgets |
| #29 | [#40](https://github.com/yevgetman/sovereign-ai-sdk/pull/40) | Exact-model image/tool validation before inference or compaction |
| #30 | [#41](https://github.com/yevgetman/sovereign-ai-sdk/pull/41) | Immutable pricing snapshots and explicit incomplete usage receipts |
| #32 | [#42](https://github.com/yevgetman/sovereign-ai-sdk/pull/42) | Versioned machine discovery, bounded pagination and offline snapshots |
| #31 | [#34](https://github.com/yevgetman/sovereign-ai-sdk/pull/34) | Separate OpenRouter execution-host and privacy policy |
| #33 | [#43](https://github.com/yevgetman/sovereign-ai-sdk/pull/43) | Shared model menus and frozen metadata across SOV turns and children |

The menus distinguish direct route → model from OpenRouter route → model author → model. Author names do not imply an observed inference host. Search, current unavailable selections and exact custom IDs remain explicit. Discovery refresh is opt-in; turn execution reads an existing node/account snapshot without a network discovery request.

All SOV-hosted turns freeze exact provider/model evidence before execution. Native children resolve their own model evidence. Unknown or stale limits use the safe 32,768-token context ceiling; fresh provider evidence can grow beyond old static windows. Output limits are ceilings and shrink to positive remaining context space. Standing instructions remain intact; duplicate generated tool help is projected onto the actual tool set.

## Release and host follow-ups

The active SDK draft is now **0.14.0**, with companion CLI **0.6.77**. It retains PR23 and adds these ten exact master merges. The legacy numeric cost helper now reports an unknown amount instead of a guessed zero when pricing or usage is incomplete. That API change requires an **SDK minor release**, rather than silently placing it in the draft 0.13.1 patch. The manifest and plan targets agree. Source package stamps remain unchanged until cut preparation. No publication or installed upgrade has occurred.

**Telekit issue #30** and **Kernel Mac installer issue #176** remain open. They cover host discovery/selection integration and release/pin work outside the SDK/SOV scope. Their completion must not be inferred from these SDK pull requests.

## Evidence boundaries

The [testing log](../../06-testing/testing-log.md) records configured checks, failed intermediate fixtures, repairs and packed external-consumer checks. Fixtures use isolated caches and fake providers. They establish source behavior within those tests; they do not establish live account entitlement, live model availability, production capacity, an installed upgrade or the Telekit user interface.

For the published baseline and existing consumers, retain the [SDK 0.13.0 / SOV 0.6.76 release snapshot](2026-10-09-sdk-release-013.md).
