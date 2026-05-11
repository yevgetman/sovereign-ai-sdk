import { describe, expect, test } from 'bun:test';
import { ApprovalQueue } from '../../src/daemon/approvalQueue.js';

describe('ApprovalQueue', () => {
  test('enqueue returns request with id, tool, and future expiry', () => {
    const q = new ApprovalQueue(5_000);
    const req = q.enqueue('sess1', 'BashTool', { command: 'ls' });
    expect(req.id).toBeString();
    expect(req.tool).toBe('BashTool');
    expect(req.sessionId).toBe('sess1');
    expect(req.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('dequeue removes and returns matching request', () => {
    const q = new ApprovalQueue(5_000);
    const req = q.enqueue('sess1', 'Read', { file_path: '/etc/hosts' });
    const got = q.dequeue(req.id);
    expect(got?.id).toBe(req.id);
    expect(q.size).toBe(0);
  });

  test('dequeue returns undefined for unknown id', () => {
    const q = new ApprovalQueue(5_000);
    expect(q.dequeue('ghost')).toBeUndefined();
  });

  test('expireStale removes entries past their TTL', async () => {
    const q = new ApprovalQueue(1); // 1 ms TTL
    q.enqueue('s', 'tool', {});
    await new Promise<void>((r) => setTimeout(r, 5));
    const removed = q.expireStale();
    expect(removed).toBe(1);
    expect(q.size).toBe(0);
  });

  test('pending returns non-expired requests after expiry pass', async () => {
    const q = new ApprovalQueue(5_000);
    q.enqueue('s1', 't1', {});
    q.enqueue('s2', 't2', {});
    const live = q.pending();
    expect(live.length).toBe(2);
  });
});
