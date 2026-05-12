// Phase 16.0c SD1 — verifies buildHarnessContext() returns a usable
// CommandContext with the Wave-1 registry pre-wired and that the
// hook callbacks (onClearHistory, onModelChange, onExitRequest) are
// invoked correctly by the slash commands.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarnessContext } from '../../src/commands/dispatchHost.js';
import { dispatchSlashCommand } from '../../src/commands/registry.js';

let home: string;
let savedHome: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-host-'));
  savedHome = process.env.HARNESS_HOME;
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.HARNESS_HOME = home;
  // Dummy key — resolveProvider() pulls it from env but no calls are
  // made during the slash-only path under test.
  if (savedKey === undefined) process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
  if (savedHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHome;
  // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  rmSync(home, { recursive: true, force: true });
});

describe('buildHarnessContext', () => {
  test('returns a CommandContext with the Wave-1 command registry pre-wired', async () => {
    const harness = await buildHarnessContext({
      getLatestCost: () => undefined,
      onExitRequest: () => {},
    });
    try {
      expect(harness.commandContext.registry.has('help')).toBe(true);
      expect(harness.commandContext.registry.has('quit')).toBe(true);
      expect(harness.commandContext.registry.has('clear')).toBe(true);
      expect(harness.commandContext.registry.has('cost')).toBe(true);
      expect(harness.commandContext.registry.has('model')).toBe(true);
      expect(harness.commandContext.registry.has('config')).toBe(true);
      expect(harness.commandContext.registry.has('about')).toBe(true);
      expect(harness.commandContext.registry.has('permissions')).toBe(true);
      expect(harness.commandContext.registry.has('tools')).toBe(true);
      expect(harness.commandContext.registry.has('skills')).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  test('/help dispatches to the registered help command', async () => {
    const harness = await buildHarnessContext({
      getLatestCost: () => undefined,
      onExitRequest: () => {},
    });
    try {
      const result = await dispatchSlashCommand('/help', harness.commandContext);
      expect(result.kind).toBe('local');
      expect(result.output).toContain('slash commands');
      expect(result.output).toContain('/help');
      expect(result.output).toContain('/quit');
    } finally {
      await harness.cleanup();
    }
  });

  test('/quit fires the onExitRequest callback', async () => {
    let exitCalled = false;
    const harness = await buildHarnessContext({
      getLatestCost: () => undefined,
      onExitRequest: () => {
        exitCalled = true;
      },
    });
    try {
      await dispatchSlashCommand('/quit', harness.commandContext);
      expect(exitCalled).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  test('/clear fires onClearHistory and reports zero on a fresh session', async () => {
    let cleared = false;
    const harness = await buildHarnessContext({
      getLatestCost: () => undefined,
      onExitRequest: () => {},
      onClearHistory: () => {
        cleared = true;
      },
    });
    try {
      const result = await dispatchSlashCommand('/clear', harness.commandContext);
      expect(cleared).toBe(true);
      expect(result.output).toContain('history cleared (0 messages)');
    } finally {
      await harness.cleanup();
    }
  });

  test('unknown slash command returns kind: unknown with help hint', async () => {
    const harness = await buildHarnessContext({
      getLatestCost: () => undefined,
      onExitRequest: () => {},
    });
    try {
      const result = await dispatchSlashCommand('/bogus', harness.commandContext);
      expect(result.kind).toBe('unknown');
      expect(result.output).toContain('unknown command');
      expect(result.output).toContain('/help');
    } finally {
      await harness.cleanup();
    }
  });
});
