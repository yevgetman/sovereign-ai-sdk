// /export and /init.
//
// Export is exercised in non-TTY mode by passing the format inline
// (`/export md`, `/export jsonl`, `/export json`). The picker path
// requires a TTY and is integration-tested manually. /init is a
// prompt-command — we verify it returns the expected content shape
// and allowedTools list.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchSlashCommand } from '../../src/commands/registry.js';
import { renderExport } from '../../src/commands/sessionOps.js';
import type { Message } from '../../src/core/types.js';
import { makeCtx } from './_makeCtx.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sov-export-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sampleMessages: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello agent' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'hello back' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt\nb.txt' }],
  },
];

describe('/export inline format', () => {
  test('refuses unknown formats', async () => {
    const ctx = makeCtx({ getMessages: () => [...sampleMessages] });
    const result = await dispatchSlashCommand('/export bogus', ctx);
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('unknown format');
  });

  test('reports nothing to export when history is empty', async () => {
    const result = await dispatchSlashCommand('/export md', makeCtx());
    if (result.kind !== 'local') throw new Error('expected local');
    expect(result.output).toContain('nothing to export');
  });

  test('writes a markdown transcript to cwd', async () => {
    await withTmp(async (dir) => {
      const ctx = makeCtx({
        cwd: dir,
        sessionId: 'abcd1234-rest',
        getMessages: () => [...sampleMessages],
      });
      const result = await dispatchSlashCommand('/export md', ctx);
      if (result.kind !== 'local') throw new Error('expected local');
      expect(result.output).toContain('exported 3 messages');
      const expectedPath = join(dir, 'session-abcd1234.md');
      expect(existsSync(expectedPath)).toBe(true);
      const body = readFileSync(expectedPath, 'utf8');
      expect(body).toContain('# Session');
      expect(body).toContain('## Turn 1 — User');
      expect(body).toContain('### Assistant');
      expect(body).toContain('hello back');
      expect(body).toContain('**→ tool: `Bash`**');
    });
  });

  test('writes a jsonl transcript with one message per line', async () => {
    await withTmp(async (dir) => {
      const ctx = makeCtx({
        cwd: dir,
        sessionId: 'beef0001-rest',
        getMessages: () => [...sampleMessages],
      });
      await dispatchSlashCommand('/export jsonl', ctx);
      const body = readFileSync(join(dir, 'session-beef0001.jsonl'), 'utf8');
      const lines = body.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0] ?? '').role).toBe('user');
      expect(JSON.parse(lines[1] ?? '').role).toBe('assistant');
    });
  });

  test('writes a pretty-printed json transcript with metadata', async () => {
    await withTmp(async (dir) => {
      const ctx = makeCtx({
        cwd: dir,
        sessionId: 'cafe0001-rest',
        providerName: 'anthropic',
        model: 'haiku',
        bundlePath: null,
        getMessages: () => [...sampleMessages],
      });
      await dispatchSlashCommand('/export json', ctx);
      const body = readFileSync(join(dir, 'session-cafe0001.json'), 'utf8');
      const parsed = JSON.parse(body);
      expect(parsed.providerName).toBe('anthropic');
      expect(parsed.model).toBe('haiku');
      expect(parsed.bundlePath).toBeNull();
      expect(parsed.messages).toHaveLength(3);
    });
  });
});

describe('renderExport', () => {
  test('jsonl is round-trippable line-by-line', () => {
    const out = renderExport(sampleMessages, 'jsonl', makeCtx());
    const parsed = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(3);
    expect(parsed[1].content[1].name).toBe('Bash');
  });

  test('markdown is human-readable and content-block aware', () => {
    const out = renderExport(sampleMessages, 'md', makeCtx());
    expect(out).toContain('## Turn 1 — User');
    expect(out).toContain('**← result**');
    expect(out).toContain('a.txt');
  });
});

describe('/init prompt command', () => {
  test('returns a prompt command with FileWrite scope and target path', async () => {
    const result = await dispatchSlashCommand('/init', makeCtx());
    expect(result.kind).toBe('prompt');
    if (result.kind !== 'prompt') return;
    expect(result.command.allowedTools).toContain('FileWrite');
    expect(result.command.allowedTools).toContain('Glob');
    expect(result.content[0]?.type).toBe('text');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('CONTEXT.md');
    expect(text).toContain('Project');
    expect(text).toContain('Entry points');
  });

  test('honors a custom target path', async () => {
    const result = await dispatchSlashCommand('/init ./docs/HARNESS.md', makeCtx());
    if (result.kind !== 'prompt') throw new Error('expected prompt');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('./docs/HARNESS.md');
  });
});
