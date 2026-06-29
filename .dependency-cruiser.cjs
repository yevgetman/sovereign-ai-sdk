// File-level open-core boundary lint (dependency-cruiser).
//
// Enforces the prime invariant of the SDK extraction: OPEN-core code must never
// import — by VALUE or by TYPE — from PROPRIETARY (or wrapper) code.
// Authoritative partition: specs/2026-06-29-sdk-open-core-extraction-design.md §4.
// The file-level partition (incl. the split-dir exceptions) lives in
// scripts/boundary-manifest.json; this config compiles it into the rule.
//
// `tsPreCompilationDeps: true` is load-bearing: without it dependency-cruiser
// drops `import type` / type-only imports (they erase at compile time), and the
// known type-only crossing executorPort.ts -> subprocessExecutor.ts would be
// missed. The rule sets NO `dependencyTypes`/`dependencyTypesNot` filter, so
// BOTH value and type edges are caught.
//
// NOTE (Task 1.7): all 47 open→proprietary crossings are resolved (GREEN), and
// `boundary` is now WIRED INTO `bun run lint` (after biome) so the gate fails on
// any new open→proprietary import. Run `bun run boundary` standalone for the
// deterministic edge list.

const manifest = require("./scripts/boundary-manifest.json");

// OPEN = fully-open dirs + the open files of split dirs + open files that live
// inside an otherwise-proprietary dir. Everything else under src/ is NON-OPEN.
const OPEN = [
  ...manifest.openFullyDirs,
  ...manifest.openSplitDirFiles,
  ...manifest.openFilesInProprietaryDirs,
  ...manifest.openRootFiles,
];

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
      from: { path: OPEN },
      to: {
        // NON-OPEN = under src/ AND not in the OPEN set (its complement).
        path: "^src/",
        pathNot: OPEN,
      },
    },
  ],
  options: {
    // Critical: include type-only / pre-compilation imports so `import type`
    // crossings are caught (default false would erase them).
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
    enhancedResolveOptions: {
      // The codebase writes `.js` specifiers that resolve to `.ts` sources
      // (moduleResolution: bundler); let the resolver see TS extensions.
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
  },
};
