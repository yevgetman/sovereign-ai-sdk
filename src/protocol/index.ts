// Contract #2 — the open wire-protocol barrel.
//
// PURE TYPES + path-string constants only. This is a SIBLING surface to the
// Contract #1 SDK barrel (src/sdk.ts) — it is intentionally NOT re-exported from
// sdk.ts, because in Phase 8 it splits into its own package `@yevgetman/sov-protocol`
// (distinct from `@yevgetman/sov-sdk`). The gateway, the Go TUI, and
// resume-as-code all adopt this single source of truth, collapsing the three
// hand-copies of the wire shapes.
//
// `export *` is verbatimModuleSyntax-safe here (star re-exports erase types
// automatically and carry the single runtime value, PROTOCOL_PATHS).

export * from './events.js';
export * from './endpoints.js';
