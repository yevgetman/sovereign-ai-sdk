import { describe, expect, test } from 'bun:test';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import { buildToolScope, filterParseableRules } from '@yevgetman/sov-sdk/tool/toolScope';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { BashTool } from '@yevgetman/sov-sdk/tools/BashTool';
import { FileReadTool } from '@yevgetman/sov-sdk/tools/FileReadTool';

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

// F2 — the /skill turn path filters a skill's declared allowedTools through
// this before buildToolScope, so a single genuinely-malformed entry degrades
// to "that rule is ignored" instead of throwing in parsePermissionRule and
// failing the whole turn.
describe('filterParseableRules (F2)', () => {
  test('keeps valid entries unchanged', () => {
    expect(filterParseableRules(['Read', 'Bash(git status)', 'Grep'])).toEqual([
      'Read',
      'Bash(git status)',
      'Grep',
    ]);
  });

  test('drops an unparseable entry (open paren, no close) and keeps the rest', () => {
    const warnings: string[] = [];
    const kept = filterParseableRules(['Read', 'Bash(git log'], (m) => warnings.push(m));
    expect(kept).toEqual(['Read']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Bash(git log');
  });

  test('drops an entry with an invalid tool selector', () => {
    // A `(` triggers the closing-paren check; `bad name(x)` has a space in the
    // selector → invalid tool selector throw.
    expect(filterParseableRules(['Read', 'bad name(x)'])).toEqual(['Read']);
  });

  test('returns an empty list when every entry is unparseable', () => {
    expect(filterParseableRules(['Bash(git log', 'also bad('])).toEqual([]);
  });

  test('returns an empty list for an empty input', () => {
    expect(filterParseableRules([])).toEqual([]);
  });

  test('does not throw when no warn callback is supplied', () => {
    expect(() => filterParseableRules(['Bash(oops'])).not.toThrow();
    expect(filterParseableRules(['Bash(oops'])).toEqual([]);
  });
});
