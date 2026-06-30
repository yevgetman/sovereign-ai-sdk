// Contract #2 — the open wire-protocol barrel (the `@yevgetman/sov-protocol`
// package entry; exposed at the `./protocol` subpath by the Phase-8 exports map).
//
// It gathers the wire TYPES (events + endpoints) + the thin, fetch-based typed
// CLIENT into one importable surface: "the wire types + client". This is a
// SIBLING surface to the Contract #1 SDK barrel (src/sdk.ts) — it is
// intentionally NOT re-exported from sdk.ts, because in Phase 8 it splits into
// its own package `@yevgetman/sov-protocol` (distinct from `@yevgetman/sov-sdk`).
// The gateway, the Go TUI, and resume-as-code all adopt this single source of
// truth, collapsing the three hand-copies of the wire shapes + the SSE parser.
//
// Runtime VALUE exports (everything else erases — `export *` is
// verbatimModuleSyntax-safe for the type re-exports): `PROTOCOL_PATHS` (the path
// templates) + the 6 fetch client functions (createSession, postTurn,
// postApproval, cancel, health, streamEvents). The client is OPEN + dependency-
// free beyond the global `fetch` and these same types, so the barrel pulls no
// runtime/proprietary code. Pinned by tests/protocol/surface.test.ts (values) +
// tests/protocol/surface.types.ts (the exported TYPES, at typecheck time).

export * from './events.js';
export * from './endpoints.js';
export * from './client.js';
