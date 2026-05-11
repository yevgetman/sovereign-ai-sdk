// Approval queue. Holds pending permission requests from background tasks.
// Entries expire after TTL if no approval/denial arrives — prevents
// long-running tasks from blocking indefinitely on an absent operator.

import { randomUUID } from 'node:crypto';

export type ApprovalRequest = {
  readonly id: string;
  readonly sessionId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
};

const DEFAULT_TTL_MS = 5 * 60 * 1_000; // 5 minutes

export class ApprovalQueue {
  private readonly queue = new Map<string, ApprovalRequest>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  enqueue(sessionId: string, tool: string, input: unknown): ApprovalRequest {
    const id = randomUUID();
    const now = new Date();
    const req: ApprovalRequest = {
      id,
      sessionId,
      tool,
      input,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
    };
    this.queue.set(id, req);
    return req;
  }

  dequeue(id: string): ApprovalRequest | undefined {
    const req = this.queue.get(id);
    if (req !== undefined) this.queue.delete(id);
    return req;
  }

  /** Returns all non-expired requests, pruning stale ones as a side effect. */
  pending(): ApprovalRequest[] {
    this.expireStale();
    return [...this.queue.values()];
  }

  /** Removes expired entries. Returns the count removed. */
  expireStale(): number {
    const now = new Date();
    let count = 0;
    for (const [id, req] of this.queue) {
      if (req.expiresAt <= now) {
        this.queue.delete(id);
        count++;
      }
    }
    return count;
  }

  get size(): number {
    return this.queue.size;
  }
}
