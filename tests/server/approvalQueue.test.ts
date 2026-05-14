import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApprovalQueue } from '../../src/server/approvalQueue.js';

describe('ApprovalQueue', () => {
  let queue: ApprovalQueue;

  beforeEach(() => {
    queue = new ApprovalQueue();
  });

  afterEach(() => {
    queue.disposeAll();
  });

  test('createPending returns a promise that resolves on matching resolve', async () => {
    const pending = queue.createPending('req-1', 1000);
    queue.resolve('req-1', { approved: true });
    const result = await pending;
    expect(result.approved).toBe(true);
  });

  test('createPending resolves with approved:false after timeout', async () => {
    const pending = queue.createPending('req-2', 50);
    const result = await pending;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  test('resolve on an unknown requestId is a no-op', () => {
    // Should not throw.
    queue.resolve('does-not-exist', { approved: true });
  });

  test('resolve twice on the same requestId is idempotent (no-op on second call)', async () => {
    const pending = queue.createPending('req-3', 1000);
    queue.resolve('req-3', { approved: true });
    queue.resolve('req-3', { approved: false }); // second call ignored
    const result = await pending;
    expect(result.approved).toBe(true);
  });

  test('cancel rejects the pending promise', async () => {
    const pending = queue.createPending('req-4', 1000);
    queue.cancel('req-4');
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  test('hasPending returns true between create and resolve', () => {
    expect(queue.hasPending('req-5')).toBe(false);
    queue.createPending('req-5', 1000);
    expect(queue.hasPending('req-5')).toBe(true);
    queue.resolve('req-5', { approved: false });
    expect(queue.hasPending('req-5')).toBe(false);
  });

  test('disposeAll cancels every pending request', async () => {
    const p1 = queue.createPending('req-6', 1000);
    const p2 = queue.createPending('req-7', 1000);
    queue.disposeAll();
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
  });
});
