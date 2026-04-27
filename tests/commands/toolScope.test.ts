import { describe, expect, test } from 'bun:test';
import { buildToolScope } from '../../src/commands/toolScope.js';
import type { CanUseTool } from '../../src/permissions/types.js';
import type { Tool, ToolContext } from '../../src/tool/types.js';
import { BashTool } from '../../src/tools/BashTool.js';
import { FileReadTool } from '../../src/tools/FileReadTool.js';

const ctx: ToolContext = {
  cwd: process.cwd(),
  bundleRoot: process.cwd(),
  sessionId: 'scope-test',
};

const bashTool = BashTool as unknown as Tool<unknown, unknown>;
const fileReadTool = FileReadTool as unknown as Tool<unknown, unknown>;

describe('buildToolScope', () => {
  test('filters visible tools and denies calls outside command scope', async () => {
    const base: CanUseTool = async () => ({ behavior: 'allow' });
    const scoped = buildToolScope({
      allowedTools: ['Bash(git status)'],
      tools: [bashTool, fileReadTool],
      canUseTool: base,
    });

    expect(scoped.tools.map((tool) => tool.name)).toEqual(['Bash']);
    expect((await scoped.canUseTool(bashTool, { command: 'git status' }, ctx)).behavior).toBe(
      'allow',
    );
    const blockedBash = await scoped.canUseTool(bashTool, { command: 'git push --force' }, ctx);
    expect(blockedBash.behavior).toBe('deny');
    expect(blockedBash.reason).toContain('slash-command scope');
    const blockedRead = await scoped.canUseTool(fileReadTool, { path: 'README.md' }, ctx);
    expect(blockedRead.behavior).toBe('deny');
  });

  test('double-star scoped Bash rules allow multi-arg git commands', async () => {
    const base: CanUseTool = async () => ({ behavior: 'allow' });
    const scoped = buildToolScope({
      allowedTools: ['Bash(git status **)', 'Bash(git commit **)'],
      tools: [bashTool],
      canUseTool: base,
    });

    const status = await scoped.canUseTool(bashTool, { command: 'git status --short' }, ctx);
    expect(status.behavior).toBe('allow');

    const commit = await scoped.canUseTool(
      bashTool,
      { command: 'git commit -m "phase 8 slash commands"' },
      ctx,
    );
    expect(commit.behavior).toBe('allow');
  });

  test('scoped Bash rules deny cd-prefixed and chained commands', async () => {
    const base: CanUseTool = async () => ({ behavior: 'allow' });
    const scoped = buildToolScope({
      allowedTools: ['Bash(git status)', 'Bash(git status **)'],
      tools: [bashTool],
      canUseTool: base,
    });

    const cdStatus = await scoped.canUseTool(bashTool, { command: 'cd /tmp && git status' }, ctx);
    expect(cdStatus.behavior).toBe('deny');

    const chained = await scoped.canUseTool(
      bashTool,
      { command: 'git status && rm -rf /tmp/nope' },
      ctx,
    );
    expect(chained.behavior).toBe('deny');
  });
});
