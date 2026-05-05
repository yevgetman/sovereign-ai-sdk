// summarizeToolResult — per-tool footer string derivation. Pure helper;
// no IO. Tested in isolation from the slot rendering.

import { describe, expect, test } from 'bun:test';
import { summarizeToolResult } from '../../src/ui/toolFooter.js';

describe('summarizeToolResult', () => {
  test('Bash success extracts exit code from envelope', () => {
    const content =
      'status: success\nsummary: ls -la\nartifacts:\n\nexit code: 0\nstdout:\nfile.txt';
    const out = summarizeToolResult({
      toolName: 'Bash',
      content,
      isError: false,
      totalLines: 6,
    });
    expect(out.primary).toBe('exit 0 · 6 lines');
  });

  test('Bash error: exit code in envelope drives the footer', () => {
    const content =
      'status: error\nsummary: ls /nope\n\nexit code: 1\nstderr:\nls: /nope: No such file';
    const out = summarizeToolResult({
      toolName: 'Bash',
      content,
      isError: true,
      totalLines: 6,
    });
    expect(out.primary).toBe('exit 1 · 6 lines');
  });

  test('FileRead footer is "read N lines"', () => {
    const out = summarizeToolResult({
      toolName: 'FileRead',
      content: 'line1\nline2\nline3',
      isError: false,
      totalLines: 250,
    });
    expect(out.primary).toBe('read 250 lines');
  });

  test('FileRead alias "Read" works the same', () => {
    const out = summarizeToolResult({
      toolName: 'Read',
      content: 'x',
      isError: false,
      totalLines: 1,
    });
    expect(out.primary).toBe('read 1 line');
  });

  test('FileWrite extracts the path from envelope artifacts', () => {
    const content = 'status: success\nsummary: wrote\nartifacts:\n  - src/foo.ts\n';
    const out = summarizeToolResult({
      toolName: 'FileWrite',
      content,
      isError: false,
      totalLines: 4,
    });
    expect(out.primary).toBe('wrote src/foo.ts');
  });

  test('FileWrite without artifacts falls back to generic "wrote file"', () => {
    const out = summarizeToolResult({
      toolName: 'FileWrite',
      content: 'no envelope here',
      isError: false,
      totalLines: 1,
    });
    expect(out.primary).toBe('wrote file');
  });

  test('FileEdit extracts replacement count from envelope', () => {
    const content = 'status: success\nsummary: edited\nreplacements: 3';
    const out = summarizeToolResult({
      toolName: 'FileEdit',
      content,
      isError: false,
      totalLines: 3,
    });
    expect(out.primary).toBe('3 replacements');
  });

  test('FileEdit handles 1 replacement (singular)', () => {
    const out = summarizeToolResult({
      toolName: 'FileEdit',
      content: 'replacements: 1',
      isError: false,
      totalLines: 1,
    });
    expect(out.primary).toBe('1 replacement');
  });

  test('Grep with multiple files reports both line and file counts', () => {
    const content = ['src/a.ts:1:foo', 'src/a.ts:5:foo', 'src/b.ts:3:foo'].join('\n');
    const out = summarizeToolResult({
      toolName: 'Grep',
      content,
      isError: false,
      totalLines: 3,
    });
    expect(out.primary).toBe('matched 3 lines · in 2 files');
  });

  test('Grep with no matches reports "no matches"', () => {
    const out = summarizeToolResult({
      toolName: 'Grep',
      content: '',
      isError: false,
      totalLines: 0,
    });
    expect(out.primary).toBe('no matches');
  });

  test('Glob reports file count', () => {
    const out = summarizeToolResult({
      toolName: 'Glob',
      content: 'a.ts\nb.ts\nc.ts',
      isError: false,
      totalLines: 3,
    });
    expect(out.primary).toBe('found 3 files');
  });

  test('Glob with no matches reports "no files matched"', () => {
    const out = summarizeToolResult({
      toolName: 'Glob',
      content: '',
      isError: false,
      totalLines: 0,
    });
    expect(out.primary).toBe('no files matched');
  });

  test('AgentTool extracts terminal/turns/tool_calls from envelope', () => {
    const content =
      '<subagent_result name="explore" session="abc" lane="anthropic/claude-haiku-4-5" turns="3" tool_calls="2" duration_ms="5400" terminal="completed">\nFound it.\n</subagent_result>';
    const out = summarizeToolResult({
      toolName: 'AgentTool',
      content,
      isError: false,
      totalLines: 3,
    });
    expect(out.primary).toBe('completed · 3 turns · 2 tool calls');
  });

  test('AgentTool envelope with 1 turn / 1 tool call uses singular forms', () => {
    const content =
      '<subagent_result name="x" session="y" lane="a/b" turns="1" tool_calls="1" duration_ms="100" terminal="completed">\nok\n</subagent_result>';
    const out = summarizeToolResult({
      toolName: 'AgentTool',
      content,
      isError: false,
      totalLines: 3,
    });
    expect(out.primary).toBe('completed · 1 turn · 1 tool call');
  });

  test('HarnessInfo footer is "snapshot"', () => {
    const out = summarizeToolResult({
      toolName: 'HarnessInfo',
      content: 'long snapshot text',
      isError: false,
      totalLines: 50,
    });
    expect(out.primary).toBe('snapshot');
  });

  test('Unknown tool falls back to generic line counter', () => {
    const out = summarizeToolResult({
      toolName: 'Mystery',
      content: 'a\nb\nc',
      isError: false,
      totalLines: 3,
    });
    expect(out.primary).toBe('3 lines');
  });

  test('Generic error footer takes the first non-empty line as gist', () => {
    const out = summarizeToolResult({
      toolName: 'Mystery',
      content: '\n\nSomething broke\nstack trace here',
      isError: true,
      totalLines: 4,
    });
    expect(out.primary).toBe('Something broke');
  });

  test('Error gist gets ellipsized when very long', () => {
    const out = summarizeToolResult({
      toolName: 'Mystery',
      content: 'x'.repeat(200),
      isError: true,
      totalLines: 1,
    });
    expect(out.primary).toContain('…');
    expect(out.primary.length).toBeLessThan(120);
  });
});
