import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  parsePermissionRule,
  parsePermissionRules,
  ruleMatchesTool,
  wildcardMatches,
} from '../../src/config/rules.js';
import { buildTool } from '../../src/tool/buildTool.js';
import type { Tool } from '../../src/tool/types.js';

function probeTool(): Tool<unknown, unknown> {
  return buildTool({
    name: 'FileRead',
    aliases: ['Read'],
    description: () => 'read',
    inputSchema: z.object({ path: z.string() }),
    async call() {
      return { data: 'ok' };
    },
  }) as unknown as Tool<unknown, unknown>;
}

describe('permission rule parsing', () => {
  test('parses tool-only rule', () => {
    expect(parsePermissionRule('Edit')).toEqual({ tool: 'Edit', content: null });
  });

  test('parses tool pattern rule', () => {
    expect(parsePermissionRule('Bash(git *)')).toEqual({ tool: 'Bash', content: 'git *' });
  });

  test('parses mcp-style selectors', () => {
    expect(parsePermissionRule('mcp__some-server')).toEqual({
      tool: 'mcp__some-server',
      content: null,
    });
  });

  test('rejects malformed selectors', () => {
    expect(() => parsePermissionRule('Bad Tool(*)')).toThrow('invalid tool selector');
    expect(() => parsePermissionRule('Bash(git *')).toThrow("missing closing ')'");
  });

  test('attaches behavior and raw rule', () => {
    expect(parsePermissionRules('allow', ['Read(*.ts)'])).toEqual([
      { behavior: 'allow', raw: 'Read(*.ts)', tool: 'Read', content: '*.ts' },
    ]);
  });
});

describe('permission rule matching helpers', () => {
  test('matches canonical name or alias', () => {
    const tool = probeTool();
    expect(ruleMatchesTool(tool, { tool: 'FileRead', content: null })).toBe(true);
    expect(ruleMatchesTool(tool, { tool: 'Read', content: null })).toBe(true);
    expect(ruleMatchesTool(tool, { tool: 'Write', content: null })).toBe(false);
  });

  test('file wildcard can match nested paths', () => {
    expect(wildcardMatches('*.ts', 'src/index.ts', { flavor: 'file' })).toBe(true);
    expect(wildcardMatches('*.ts', 'src/index.md', { flavor: 'file' })).toBe(false);
  });

  test('shell wildcard is token-bounded', () => {
    expect(wildcardMatches('git *', 'git status', { flavor: 'shell' })).toBe(true);
    expect(wildcardMatches('git *', 'git push --force', { flavor: 'shell' })).toBe(false);
  });
});
