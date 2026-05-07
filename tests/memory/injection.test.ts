// Memory fencing tests. The snapshot should be visibly background context
// and prepend to the current user text only.

import { describe, expect, test } from 'bun:test';
import type { Message } from '../../src/core/types.js';
import {
  FENCE_PREAMBLE,
  formatMemorySnapshot,
  injectMemoryIntoLatestUserMessage,
} from '../../src/memory/injection.js';

describe('memory injection', () => {
  test('formats fenced memory context', () => {
    const snapshot = formatMemorySnapshot({ user: 'prefers terse', memory: 'project note' });
    expect(snapshot).toContain(FENCE_PREAMBLE);
    expect(snapshot).toContain('<memory-context>');
    expect(snapshot).toContain('<USER.md>');
    expect(snapshot).toContain('<MEMORY.md>');
  });

  test('injects into latest user message without mutating input array', async () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'old' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'current' }] },
    ];
    const injected = await injectMemoryIntoLatestUserMessage(messages, {
      async prefetchSnapshot() {
        return formatMemorySnapshot({ user: 'prefers terse' });
      },
    });
    const latest = injected[2];
    expect(latest?.role).toBe('user');
    expect(latest?.content[0]?.type).toBe('text');
    if (latest?.content[0]?.type === 'text') {
      expect(latest.content[0].text).toContain('prefers terse');
      expect(latest.content[0].text).toContain('current');
    }
    expect(messages[2]?.content[0]).toEqual({ type: 'text', text: 'current' });
  });
});

describe('formatMemorySnapshot — projectMemory block', () => {
  test('omits project block when projectMemory undefined', () => {
    const out = formatMemorySnapshot({ memory: 'G', user: 'U' });
    expect(out).toContain('<USER.md>');
    expect(out).toContain('<MEMORY.md>');
    expect(out).not.toContain('scope="project"');
  });

  test('renders project block after global MEMORY.md', () => {
    const out = formatMemorySnapshot({
      memory: 'GLOBAL',
      projectMemory: { content: 'PROJ', name: 'my-bundle' },
    });
    const globalIdx = out.indexOf('<MEMORY.md>');
    const projIdx = out.indexOf('<MEMORY.md scope="project"');
    expect(globalIdx).toBeGreaterThan(-1);
    expect(projIdx).toBeGreaterThan(globalIdx);
    expect(out).toContain('project="my-bundle"');
    expect(out).toContain('PROJ');
  });

  test('renders project block when global MEMORY.md is empty', () => {
    const out = formatMemorySnapshot({
      projectMemory: { content: 'PROJ', name: 'my-bundle' },
    });
    expect(out).toContain('<MEMORY.md scope="project"');
    expect(out).not.toContain('<MEMORY.md>\n');
  });

  test('omits project block when projectMemory.content is empty/whitespace', () => {
    const out = formatMemorySnapshot({
      memory: 'GLOBAL',
      projectMemory: { content: '   \n  ', name: 'my-bundle' },
    });
    expect(out).not.toContain('scope="project"');
  });

  test('HTML-escapes the project name in the attribute', () => {
    const out = formatMemorySnapshot({
      projectMemory: { content: 'X', name: 'project<with>"quotes"' },
    });
    expect(out).toContain('project="project&lt;with&gt;&quot;quotes&quot;"');
  });

  test('HTML-escapes ampersand in project name', () => {
    const out = formatMemorySnapshot({
      projectMemory: { content: 'X', name: 'a & b' },
    });
    expect(out).toContain('project="a &amp; b"');
  });

  test('USER → global → project → nudge ordering preserved', () => {
    const out = formatMemorySnapshot({
      user: 'U',
      memory: 'G',
      projectMemory: { content: 'P', name: 'pname' },
      nudge: 'N',
    });
    const u = out.indexOf('<USER.md>');
    const g = out.indexOf('<MEMORY.md>');
    const p = out.indexOf('<MEMORY.md scope="project"');
    const n = out.indexOf('<memory-nudge>');
    expect(u).toBeLessThan(g);
    expect(g).toBeLessThan(p);
    expect(p).toBeLessThan(n);
  });
});
