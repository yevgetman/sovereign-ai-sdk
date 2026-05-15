// Phase 16.1 M7 T1 — MCP client pool wiring in buildRuntime.
//
// Verifies that buildRuntime loads MCP server settings from the layered
// cascade (loadMcpServerSettings), constructs a pool when at least one
// server is configured, wraps each discovered tool via wrapMcpTool, and
// merges the wrapped tools into runtime.toolPool. dispose() shuts the
// pool down BEFORE sessionDb.close() (M7-08 disposal order).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime — MCP client pool wiring (M7 T1)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-t1-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('no MCP servers configured → mcpClientPool is undefined and no mcp__ tools in toolPool', async () => {
    // Arrange: no settings.json with mcpServers — runtime should boot cleanly.
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    // Assert
    expect(runtime.mcpClientPool).toBeUndefined();
    const mcpToolNames = runtime.toolPool
      .filter((t) => t.name.startsWith('mcp__'))
      .map((t) => t.name);
    expect(mcpToolNames).toEqual([]);

    await runtime.dispose();
  });

  test('mcpServers configured → pool builds, mcp__ tools appear in toolPool, dispose shuts pool first', async () => {
    // Arrange: settings.json (user layer of the cascade) with an MCP server
    // pointed at the existing echo-server stdio fixture.
    const fixturePath = join(import.meta.dir, '..', 'mcp', 'fixtures', 'echo-server.ts');
    const settingsPath = join(tmpHome, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          echo: {
            command: 'bun',
            args: [fixturePath],
          },
        },
      }),
      'utf8',
    );

    let mcpShutdownCalled = false;
    let sessionDbClosed = false;
    let shutdownBeforeDbClose = false;

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });

    // Assert: pool exists, wrapped tools surfaced.
    expect(runtime.mcpClientPool).toBeDefined();
    const mcpToolNames = runtime.toolPool
      .filter((t) => t.name.startsWith('mcp__'))
      .map((t) => t.name);
    expect(mcpToolNames.length).toBeGreaterThan(0);
    expect(mcpToolNames[0]).toMatch(/^mcp__echo__/);

    // Spy on shutdown order: wrap shutdown + close to record the sequence.
    if (runtime.mcpClientPool === undefined) {
      throw new Error('mcpClientPool should be defined for spy install');
    }
    const pool = runtime.mcpClientPool;
    const realShutdown = pool.shutdown.bind(pool);
    pool.shutdown = async () => {
      mcpShutdownCalled = true;
      if (!sessionDbClosed) shutdownBeforeDbClose = true;
      await realShutdown();
    };
    const realClose = runtime.sessionDb.close.bind(runtime.sessionDb);
    runtime.sessionDb.close = () => {
      sessionDbClosed = true;
      realClose();
    };

    await runtime.dispose();

    expect(mcpShutdownCalled).toBe(true);
    expect(shutdownBeforeDbClose).toBe(true);
  });
});
