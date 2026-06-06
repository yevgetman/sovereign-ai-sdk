// Channel permission posture — the security foundation for Phase F.
//
// A channel turn is driven by an UNTRUSTED remote message (Slack / Telegram /
// webhook). It MUST run safe-by-default: it must NOT inherit the local dev's
// allow-rules, and anything that would require permission must auto-deny — so
// a remote message can never run Bash / Write / Edit.
//
// The load-bearing claims under test:
//   1. buildChannelCanUseTool denies Bash / Write / Edit (they self-check 'ask',
//      and the channel posture auto-denies on the 'ask' fallthrough).
//   2. No local-allow inheritance: even when a local settings.local.json seeds
//      `allow: Bash(*)` — which the cron posture WOULD honour — the channel
//      posture still denies Bash, because it never consults the local layers.
//   3. A read-only / safe tool (self-check 'allow') is still allowed.
//   4. assertChannelPermissionMode rejects 'bypass' and accepts 'default'/'ask';
//      'ask' still auto-denies on fallthrough (no interactive approver).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertChannelPermissionMode,
  buildChannelCanUseTool,
} from '../../src/channels/permission.js';
import { loadPermissionSettings } from '../../src/config/settings.js';
import { buildCanUseTool } from '../../src/permissions/canUseTool.js';
import type { AskUser } from '../../src/permissions/types.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';
import { BashTool } from '../../src/tools/BashTool.js';
import { FileEditTool } from '../../src/tools/FileEditTool.js';
import { FileReadTool } from '../../src/tools/FileReadTool.js';
import { FileWriteTool } from '../../src/tools/FileWriteTool.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'channel-test',
};

const bashTool = BashTool as unknown as Tool<unknown, unknown>;
const writeTool = FileWriteTool as unknown as Tool<unknown, unknown>;
const editTool = FileEditTool as unknown as Tool<unknown, unknown>;
const readTool = FileReadTool as unknown as Tool<unknown, unknown>;

// A non-read-only Bash command self-checks 'ask' (not on the read-only
// allowlist). Single-token so a `Bash(*)` allow-rule matches it under the
// shell-flavored matcher (where `*` → `\S*`), which the control test relies on.
const WRITE_BASH = { command: 'npm' };

describe('buildChannelCanUseTool', () => {
  test('denies Bash (self-check ask → auto-deny under channel posture)', async () => {
    const canUseTool = buildChannelCanUseTool();
    const result = await canUseTool(bashTool, WRITE_BASH, ctx);
    expect(result.behavior).toBe('deny');
  });

  test('denies Write', async () => {
    const canUseTool = buildChannelCanUseTool();
    const result = await canUseTool(writeTool, { path: '/tmp/x.txt', content: 'x' }, ctx);
    expect(result.behavior).toBe('deny');
  });

  test('denies Edit', async () => {
    const canUseTool = buildChannelCanUseTool();
    const result = await canUseTool(
      editTool,
      { path: '/tmp/x.txt', old_string: 'a', new_string: 'b' },
      ctx,
    );
    expect(result.behavior).toBe('deny');
  });

  test('allows a read-only / safe tool (self-check allow)', async () => {
    const canUseTool = buildChannelCanUseTool();
    const result = await canUseTool(readTool, { path: '/tmp/x.txt' }, ctx);
    expect(result.behavior).toBe('allow');
  });

  test("accepts an explicit mode: 'ask' and still auto-denies on fallthrough", async () => {
    const canUseTool = buildChannelCanUseTool({ mode: 'ask' });
    const result = await canUseTool(bashTool, WRITE_BASH, ctx);
    expect(result.behavior).toBe('deny');
  });

  // ── The security crux: no local-allow inheritance ──────────────────────────
  describe('no local-allow inheritance', () => {
    let tmpCwd: string;
    let harnessHome: string;

    beforeEach(() => {
      tmpCwd = mkdtempSync(join(tmpdir(), 'channel-perm-cwd-'));
      harnessHome = mkdtempSync(join(tmpdir(), 'channel-perm-home-'));
      // Seed a project-local allow that WOULD permit Bash(*) — the exact rule a
      // local dev might add to skip prompts. loadPermissionSettings reads this
      // from <cwd>/.harness/settings.local.json (the 'local' layer).
      mkdirSync(join(tmpCwd, '.harness'), { recursive: true });
      writeFileSync(
        join(tmpCwd, '.harness', 'settings.local.json'),
        `${JSON.stringify({ permissions: { allow: ['Bash(*)'] } }, null, 2)}\n`,
        'utf8',
      );
    });

    afterEach(() => {
      rmSync(tmpCwd, { recursive: true, force: true });
      rmSync(harnessHome, { recursive: true, force: true });
    });

    test('the seeded local allow DOES allow Bash via the cron-style posture (control)', async () => {
      // Control: prove the seed is real + effective. The cron posture inherits
      // the local layers, so it allows Bash(*) here. Channels must differ.
      const settings = loadPermissionSettings({ cwd: tmpCwd, harnessHome });
      expect(settings.layers.length).toBeGreaterThan(0);
      const ask: AskUser = async () => 'deny';
      const cronStyle = buildCanUseTool({
        mode: 'default',
        ask,
        alwaysAllow: new Set<string>(),
        ruleLayers: settings.layers,
      });
      const result = await cronStyle(bashTool, WRITE_BASH, ctx);
      expect(result.behavior).toBe('allow');
    });

    test('the channel posture STILL denies Bash despite the seeded local allow', async () => {
      // The channel posture never consults the local layers, so the seeded
      // Bash(*) allow has no effect and the 'ask' fallthrough auto-denies.
      const canUseTool = buildChannelCanUseTool();
      const result = await canUseTool(bashTool, WRITE_BASH, ctx);
      expect(result.behavior).toBe('deny');
    });
  });
});

describe('assertChannelPermissionMode', () => {
  test("throws on 'bypass'", () => {
    expect(() => assertChannelPermissionMode('bypass')).toThrow();
  });

  test("accepts 'default'", () => {
    expect(() => assertChannelPermissionMode('default')).not.toThrow();
  });

  test("accepts 'ask'", () => {
    expect(() => assertChannelPermissionMode('ask')).not.toThrow();
  });

  test('throws on an unknown mode', () => {
    expect(() => assertChannelPermissionMode('wide-open')).toThrow();
  });
});
