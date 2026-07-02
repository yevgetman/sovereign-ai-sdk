#!/usr/bin/env bun
// External-consumer canary (spec §9.3): for each open package, `npm pack` it,
// install the TARBALL into a throwaway scratch project, and run a consumer
// script under BOTH `node` and `bun`. This proves the PUBLISHED shape (the
// package.json `exports` map → compiled dist) resolves for a real external app
// — not the in-repo source. Run via `bun run canary`.
//
// After install it also runs the shipped-artifact purity check (spec §9.4)
// against the REAL installed tree — the published artifact must never import
// `bun:sqlite` or the proprietary wrapper.
//
// Node-API-only (no Bun globals) so it is itself runtime-agnostic.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

interface CanarySpec {
  name: string;
  pkgDir: string;
  consumer: string;
  token: string;
  extraInstalls?: string[];
}

// Shipped-artifact purity (spec §9.4), checked against the INSTALLED package
// tree (dist AND src) — the real artifact, not repo source. Patterns match
// quoted module specifiers only, so prose mentions in comments/docs cannot
// false-positive: every real import/require/dynamic-import form quotes the
// specifier.
// Known trade-off: a template-literal dynamic import (e.g. import(`bun:sqlite`)) would evade
// this gate — widening the quote class to include backticks would false-positive on the prose
// `bun:sqlite` mention in packages/sdk/src/core/sessionPort.ts, so it is accepted, not closed.
const FORBIDDEN_SPECIFIERS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // Backtick-free by design — see the known trade-off noted above.
  { label: "a 'bun:sqlite' import", pattern: /['"]bun:sqlite['"]/ },
  // Exact-package only: a quote or '/' must follow `sov`, so this never fires
  // on '@yevgetman/sov-sdk' or '@yevgetman/sov-protocol'.
  { label: "an import of the proprietary wrapper '@yevgetman/sov'", pattern: /['"]@yevgetman\/sov['"/]/ },
  // Any QUOTED dynamic import of a bun: module (not just sqlite). Static forms
  // of other bun: modules would fail under Node outright, but a lazily-evaluated
  // dynamic import could hide until a Node consumer hits that code path.
  // Quoted-form only (same backtick trade-off as above); `import(` + quote +
  // `bun:` never appears in prose.
  { label: "a dynamic import of a 'bun:' module", pattern: /import\(\s*['"]bun:/ },
];

// Standing self-test (Task 3.7 review fast-follow): the purity gate's failure
// mode is silent-pass, so verify every FORBIDDEN_SPECIFIERS pattern against
// known-bad/known-good fixtures before any canary spec runs — this makes
// every canary run (local + CI) self-verify the gate, not just trust it.
function selfTestForbiddenSpecifiers(): void {
  const fixtures: ReadonlyArray<{ text: string; expectMatch: ReadonlyArray<string> }> = [
    { text: "import { Database } from 'bun:sqlite';", expectMatch: ["a 'bun:sqlite' import"] },
    {
      text: "import { x } from '@yevgetman/sov';",
      expectMatch: ["an import of the proprietary wrapper '@yevgetman/sov'"],
    },
    {
      text: 'import { y } from "@yevgetman/sov/server/runtime.js";',
      expectMatch: ["an import of the proprietary wrapper '@yevgetman/sov'"],
    },
    { text: "import { createAgent } from '@yevgetman/sov-sdk';", expectMatch: [] },
    { text: "import { health } from '@yevgetman/sov-protocol';", expectMatch: [] },
    {
      text: "const ffi = await import('bun:ffi');",
      expectMatch: ["a dynamic import of a 'bun:' module"],
    },
    { text: "await import('@yevgetman/sov-sdk/config/loader');", expectMatch: [] },
    // Mirrors the real prose comment in packages/sdk/src/core/sessionPort.ts —
    // backticked, not quoted, so it must NOT trip either pattern.
    {
      text: 'the proprietary `agent/sessionDb.ts` (the `bun:sqlite` impl) or the wrapper',
      expectMatch: [],
    },
  ];
  const failures = fixtures.flatMap(({ text, expectMatch }) =>
    FORBIDDEN_SPECIFIERS.filter(({ label, pattern }) => pattern.test(text) !== expectMatch.includes(label)).map(
      ({ label }) =>
        `pattern "${label}" ${expectMatch.includes(label) ? 'failed to match' : 'false-positived on'}: ${text}`,
    ),
  );
  if (failures.length > 0) {
    throw new Error(`FORBIDDEN_SPECIFIERS self-test FAILED (purity gate is broken):\n  ${failures.join('\n  ')}`);
  }
  console.log('  ✔ FORBIDDEN_SPECIFIERS self-test passed (matches known-bad, spares known-good)');
}

function listFilesRecursively(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFilesRecursively(path) : [path];
  });
}

function assertShippedArtifactPure(scratch: string, pkgName: string): void {
  const installed = join(scratch, 'node_modules', pkgName);
  const offences = listFilesRecursively(installed).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return FORBIDDEN_SPECIFIERS.filter(({ pattern }) => pattern.test(text)).map(
      ({ label }) => `${file} contains ${label}`,
    );
  });
  if (offences.length > 0) {
    throw new Error(`${pkgName} shipped-artifact purity check FAILED:\n  ${offences.join('\n  ')}`);
  }
  console.log(`  ✔ ${pkgName} installed artifact is pure (no bun:sqlite, no wrapper imports)`);
}

function packTarball(pkgDir: string): string {
  // `npm pack --json` runs `prepack` (→ build) and emits the tarball + a JSON manifest.
  const out = execFileSync('npm', ['pack', '--json'], { cwd: pkgDir }).toString();
  const filename = JSON.parse(out)[0].filename as string;
  return join(pkgDir, filename);
}

function runCanary(spec: CanarySpec): void {
  const scratch = mkdtempSync(join(tmpdir(), 'sov-canary-'));
  try {
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'sov-canary-consumer', version: '0.0.0', type: 'module', private: true }, null, 2),
    );
    const tarball = packTarball(spec.pkgDir);
    try {
      execFileSync('npm', ['install', '--no-save', tarball, ...(spec.extraInstalls ?? [])], {
        cwd: scratch,
        stdio: 'ignore',
      });
      assertShippedArtifactPure(scratch, spec.name);
      copyFileSync(spec.consumer, join(scratch, 'consumer.mjs'));
      for (const runtime of ['node', 'bun']) {
        const out = execFileSync(runtime, ['consumer.mjs'], { cwd: scratch }).toString();
        if (!out.includes(spec.token)) {
          throw new Error(`${spec.name} canary FAILED under ${runtime}: expected '${spec.token}', got:\n${out}`);
        }
        console.log(`  ✔ ${spec.name} consumable under ${runtime}`);
      }
    } finally {
      rmSync(tarball, { force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

selfTestForbiddenSpecifiers();

console.log('External-consumer canary:');
runCanary({
  name: '@yevgetman/sov-protocol',
  pkgDir: join(repo, 'packages/protocol'),
  consumer: join(here, 'protocol-consumer.mjs'),
  token: 'PROTOCOL_OK',
});
runCanary({
  name: '@yevgetman/sov-sdk',
  pkgDir: join(repo, 'packages/sdk'),
  consumer: join(here, 'sdk-consumer.mjs'),
  token: 'SDK_OK',
  // The consumer imports zod DIRECTLY (for its tool's input schema), so the
  // scratch app declares its own copy; the SDK's runtime deps arrive with the
  // tarball install itself.
  extraInstalls: ['zod@^3.24.0'],
});
console.log('All consumer canaries passed.');
