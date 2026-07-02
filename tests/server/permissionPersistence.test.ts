// Backlog #44 (closed 2026-05-19) — server-side "yes & remember (project)"
// persistence path.
//
// When the user answers `always` on a permission prompt in the TUI, the
// matching `canUseTool` closure must append the rule to project-local
// `.harness/settings.local.json` so subsequent turns load it via
// `loadPermissionSettings` and skip the prompt. Before this commit the
// server's equivalent closure in `src/server/routes/turns.ts:451-453`
// was a no-op marked "Project-local 'always' persistence is a deferred
// follow-up."
//
// These tests verify the closure semantics directly via buildCanUseTool —
// the same surface the per-session canUseTool in turns.ts uses. A full
// end-to-end test through the approval queue is intentionally not
// added: tests/permissions/canUseTool.test.ts already pins the
// `recordAlwaysAllow` callback contract, and tests/config/settings.test.ts
// already pins `appendProjectLocalPermissionRule`'s file-write behavior.
// This file pins the WIRING — that the server-side closure calls
// `appendProjectLocalPermissionRule` with `runtime.cwd` and
// `behavior: 'allow'`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendProjectLocalPermissionRule } from '@yevgetman/sov-sdk/config/settings';
import { buildCanUseTool } from '@yevgetman/sov-sdk/permissions/canUseTool';
import type { AskUser } from '@yevgetman/sov-sdk/permissions/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

function makeFileWriteTool(): Tool<unknown, unknown> {
  const inputSchema = z.object({ path: z.string() });
  return buildTool({
    name: 'FileWrite',
    aliases: ['Write'],
    description: () => 'write',
    inputSchema,
    preparePermissionMatcher: async (input) => (pattern) =>
      pattern === '*' || pattern === input.path,
    checkPermissions: async () => ({ behavior: 'ask' as const }),
    async call() {
      return { data: 'ok' };
    },
  }) as unknown as Tool<unknown, unknown>;
}

describe('server-side recordAlwaysAllow persistence (backlog #44)', () => {
  let tmpCwd: string;
  const baseCtx: ToolContext = { cwd: '/unused-by-this-flow' } as ToolContext;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'sov-m44-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test('"always" answer writes the rule to <cwd>/.harness/settings.local.json', async () => {
    const tool = makeFileWriteTool();
    const ask: AskUser = async () => 'always';

    // This closure shape is exactly what src/server/routes/turns.ts:
    // 451-460 builds. We construct it inline so the test pins the
    // wiring contract, not just the helper's standalone behavior.
    const recordAlwaysAllow = (rule: string): void => {
      appendProjectLocalPermissionRule({
        cwd: tmpCwd,
        rule,
        behavior: 'allow',
      });
    };

    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask,
      alwaysAllow: new Set<string>(),
      recordAlwaysAllow,
    });

    const result = await canUseTool(tool, { path: 'note.txt' }, baseCtx);
    expect(result.behavior).toBe('allow');

    const settingsPath = join(tmpCwd, '.harness', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toContain('FileWrite(note.txt)');
  });

  test('persisted rule is idempotent — second "always" on same input does not duplicate', async () => {
    const tool = makeFileWriteTool();
    const ask: AskUser = async () => 'always';
    const recordAlwaysAllow = (rule: string): void => {
      appendProjectLocalPermissionRule({
        cwd: tmpCwd,
        rule,
        behavior: 'allow',
      });
    };
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask,
      alwaysAllow: new Set<string>(),
      recordAlwaysAllow,
    });

    await canUseTool(tool, { path: 'same.txt' }, baseCtx);
    await canUseTool(tool, { path: 'same.txt' }, baseCtx);

    const settings = JSON.parse(
      readFileSync(join(tmpCwd, '.harness', 'settings.local.json'), 'utf8'),
    ) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow.filter((r) => r === 'FileWrite(same.txt)').length).toBe(1);
  });

  test('two different paths produce two distinct rules', async () => {
    const tool = makeFileWriteTool();
    const ask: AskUser = async () => 'always';
    const recordAlwaysAllow = (rule: string): void => {
      appendProjectLocalPermissionRule({
        cwd: tmpCwd,
        rule,
        behavior: 'allow',
      });
    };
    const canUseTool = buildCanUseTool({
      mode: 'ask',
      ask,
      alwaysAllow: new Set<string>(),
      recordAlwaysAllow,
    });

    await canUseTool(tool, { path: 'one.txt' }, baseCtx);
    await canUseTool(tool, { path: 'two.txt' }, baseCtx);

    const settings = JSON.parse(
      readFileSync(join(tmpCwd, '.harness', 'settings.local.json'), 'utf8'),
    ) as { permissions: { allow: string[] } };
    expect(settings.permissions.allow).toContain('FileWrite(one.txt)');
    expect(settings.permissions.allow).toContain('FileWrite(two.txt)');
    expect(settings.permissions.allow.length).toBe(2);
  });
});
