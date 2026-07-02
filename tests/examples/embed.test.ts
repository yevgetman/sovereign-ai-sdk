// Task 8.1 — the example-consumer CANARY.
//
// Two proofs that the OPEN SDK is a real, importable, NO-DISK surface:
//   1. The external-style consumer (examples/embed/embed.ts) runs a full turn
//      against a scripted offline provider — dispatching one tool — and yields a
//      final assistant message, all from the `@yevgetman/sov-sdk` barrel.
//   2. The open core never pulls SQLite. We cruise the RUNTIME (value) dependency
//      graph of `packages/sdk/src/sdk.ts` with dependency-cruiser and assert NO module in it
//      resolves to `bun:sqlite` or to `agent/sessionDb` — `import type`-only
//      crossings erase, so this catches a real value import of the closed
//      SessionDb. As a belt-and-suspenders check we also run an in-memory turn in
//      a fresh temp cwd and assert no DB file was created there.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cruise } from 'dependency-cruiser';
import { EMBED_FINAL_TEXT, runEmbed } from '../../examples/embed/embed.js';

/** Minimal shape of the dependency-cruiser JSON result we read. */
type CruiseDep = { resolved?: string; module?: string };
type CruiseModule = { source: string; dependencies?: CruiseDep[] };

describe('examples/embed canary — Contract #1 no-disk consumer', () => {
  test('runEmbed completes a tool-dispatching turn with a final assistant message', async () => {
    const { text, result } = await runEmbed();

    expect(result.terminal.reason).toBe('completed');
    expect(result.finalAssistant).toBeDefined();
    expect(text).toBe(EMBED_FINAL_TEXT);
    // The trivial Echo tool was actually dispatched (the full loop ran).
    expect(result.toolCallCount).toBe(1);
    expect(result.distinctToolNames).toEqual(['Echo']);
    // A fresh session id was minted in memory; nothing persisted to disk.
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  test('the SDK barrel value-dep graph never reaches bun:sqlite / agent/sessionDb', async () => {
    // No `tsPreCompilationDeps` → type-only (`import type`) edges are dropped, so
    // any remaining edge to bun:sqlite/sessionDb would be a real VALUE import.
    const cruiseOptions: Parameters<typeof cruise>[1] = {
      doNotFollow: { path: 'node_modules' },
      exclude: { path: 'node_modules' },
      tsConfig: { fileName: 'tsconfig.json' },
      enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'] },
    };

    const report = await cruise(['packages/sdk/src/sdk.ts'], cruiseOptions);
    const output = report.output;
    const parsed = typeof output === 'string' ? JSON.parse(output) : output;
    const modules = (parsed as { modules: CruiseModule[] }).modules;

    // Sanity: we actually cruised the barrel's graph (it has many open modules).
    expect(modules.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const mod of modules) {
      if (/agent\/sessionDb/.test(mod.source)) {
        offenders.push(`module:${mod.source}`);
      }
      for (const dep of mod.dependencies ?? []) {
        const target = dep.resolved ?? dep.module ?? '';
        if (/bun:sqlite/.test(target) || /bun:sqlite/.test(dep.module ?? '')) {
          offenders.push(`${mod.source} -> ${target}`);
        }
        if (/agent\/sessionDb/.test(target)) {
          offenders.push(`${mod.source} -> ${target}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  describe('an in-memory turn writes no DB file', () => {
    let tmp: string;

    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), 'sov-embed-canary-'));
    });

    afterAll(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    test('the temp cwd stays empty after the turn (no sqlite/db artifact)', async () => {
      const { result } = await runEmbed({ cwd: tmp });
      expect(result.terminal.reason).toBe('completed');

      const entries = readdirSync(tmp);
      const dbFiles = entries.filter((name) => /\.(db|sqlite|sqlite3)$/.test(name));
      expect(dbFiles).toEqual([]);
      // Nothing at all should have been written to the cwd by an in-memory turn.
      expect(entries).toEqual([]);
      expect(existsSync(join(tmp, 'sessions.db'))).toBe(false);
    });
  });
});
