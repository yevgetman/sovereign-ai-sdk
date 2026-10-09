# SDK context-management implementation

Bounded part of issue #15. Build only the injected open-core port; retain the
owner's separate decision about licensing a reusable summary implementation.

> **Status:** implemented 2026-10-09; see phases below. Native-child policy
> integration belongs to the aggregate PR. A bundled reusable summary engine
> remains deferred pending the owner's license-boundary decision.

### Phase 1 — Port and model-history validation
**Status:** complete (2026-10-09)

Landed artifacts: compact/contextManagement.ts; config/per-turn/query injection;
strict replacement/tool-adjacency checks; model-only history replacement.

### Phase 2 — Lifecycle and honest accounting
**Status:** complete (2026-10-09)

Landed artifacts: one overflow retry before output/tools; cooperative cancellation;
context_management events; additive summary usage; unknown-cost handling;
legacy optional truncateMessages capability with typed fail-closed regeneration.

### Phase 3 — Source and packed checks
**Status:** complete (2026-10-09)

Landed artifacts: deterministic regression tests, updated public API witnesses,
complete lint/typecheck/unskipped suite and packed Node/Bun consumer evidence.
Root integrates explicit native-child policy and verifies its inherited port
separately in the aggregate issue #15 PR.

## Read next

- `specs/2026-10-09-sdk-context-management-design.md`
- `tests/compact/contextManagement.test.ts`
- `docs/06-testing/testing-log.md`
