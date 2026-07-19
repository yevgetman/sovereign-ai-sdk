// Open-core boundary lint (dependency-cruiser) — POST-MOVE (Phase 3).
//
// Enforces the prime invariant of the SDK extraction, rebased onto the physical
// package split: an OPEN package (packages/sdk, packages/protocol) must never
// depend — by VALUE or by TYPE — on the proprietary WRAPPER (the repo root
// src/ tree), in either of its two reachable forms:
//   1. a relative import escaping the package (resolves under ^src/), or
//   2. the root package name @yevgetman/sov (raw specifier or resolved through
//      node_modules; the trailing-boundary regex spares @yevgetman/sov-sdk and
//      @yevgetman/sov-protocol).
// The open partition itself lives in scripts/boundary-manifest.json; this
// config compiles it into the rule. Cruise targets are the two package src
// dirs (see the `boundary` npm script).
//
// `tsPreCompilationDeps: true` is load-bearing: without it dependency-cruiser
// drops `import type` / type-only imports (they erase at compile time). The
// rule sets NO `dependencyTypes`/`dependencyTypesNot` filter, so BOTH value
// and type edges are caught.
//
// The gate is WIRED INTO `bun run lint` (after biome); run `bun run boundary`
// standalone for the deterministic edge list.

const manifest = require("./scripts/boundary-manifest.json");

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-open-to-proprietary",
      comment:
        "Open-core SDK code must not depend (value OR type) on proprietary/wrapper " +
        "code. Relocate the leaf, invert to an injected port, or move the importer " +
        "to the proprietary side. See specs/2026-06-29-sdk-open-core-extraction-design.md §4.",
      severity: "error",
      from: { path: manifest.openPackageDirs },
      to: { path: manifest.forbiddenWrapperTargets },
    },
    {
      name: "no-open-to-engine",
      comment:
        "Open-core SDK code must not depend (value OR type) on the proprietary " +
        "conduct engine @yevgetman/decorum — the SDK ships the vendor-neutral " +
        "Conduct Port only; the root wrapper binds the engine via injection. " +
        "Keep engine-shaped data at the port as plain strings (see " +
        "specs/2026-07-19-gateway-attestation-evidence-design.md §2/§3.4).",
      severity: "error",
      from: { path: manifest.openPackageDirs },
      to: { path: manifest.forbiddenEngineTargets },
    },
  ],
  options: {
    // Critical: include type-only / pre-compilation imports so `import type`
    // crossings are caught (default false would erase them).
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    // node_modules is excluded from the cruise EXCEPT the forbidden engine
    // package: a blanket exclude silently drops the resolved decorum module
    // from the graph, making the no-open-to-engine rule vacuous for the
    // resolvable (workspace-installed) import form — the exact hole the
    // 2026-07-19 review found. Bun's isolated store resolves it as
    // node_modules/.bun/@yevgetman+decorum@…/node_modules/@yevgetman/decorum/…
    // (TWO node_modules segments, `+`-joined store key), so the negative
    // lookahead scans the rest of the path for either form and keeps decorum
    // visible as a LEAF target (doNotFollow above still stops the cruise from
    // descending into it). @yevgetman/sov-sdk / -protocol / everything else
    // stay excluded (the `[@/]|$` boundary spares suffixed names).
    exclude: { path: "node_modules/(?!.*@yevgetman[/+]decorum([@/]|$))" },
    enhancedResolveOptions: {
      // The codebase writes `.js` specifiers that resolve to `.ts` sources
      // (moduleResolution: bundler); let the resolver see TS extensions.
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
  },
};
