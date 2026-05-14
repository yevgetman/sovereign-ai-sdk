// Phase 16.1 M5 — permission-request approval queue.
//
// One queue per server instance. Each pending request is keyed by a
// caller-supplied `requestId`; the queue manages the promise lifecycle,
// the timeout timer, and idempotent resolve / cancel semantics.
//
// Coupling: this module knows nothing about HTTP, SSE, or buses. The
// caller (serverAsk + approvals route) emits the SSE event and POSTs
// the resolution; ApprovalQueue is the in-memory rendezvous.

export type ApprovalResponse = {
  approved: boolean;
  /** When true, the user picked "always" — the AskUser bridge should
   *  return `'always'` instead of `'allow'` so canUseTool registers a
   *  session-scoped allow rule. Only meaningful when `approved === true`.
   *  Defaults to undefined (which behaves like `false`) to keep existing
   *  callers unaffected. */
  always?: boolean;
  /** Optional input override (the user's "ask" callback can rewrite the
   *  tool input before the tool runs — e.g., redact a secret). */
  updatedInput?: unknown;
  /** Set to 'timeout' when the queue itself resolves on TTL expiry. The
   *  approvals route never sets this; only the timer does. */
  reason?: 'timeout';
};

type PendingEntry = {
  resolve: (response: ApprovalResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ApprovalQueue {
  private pending = new Map<string, PendingEntry>();

  /** Register a pending request. Resolves with the response when the
   *  caller calls `resolve(requestId, ...)`. Resolves with
   *  `{ approved: false, reason: 'timeout' }` if `timeoutMs` elapses
   *  first. Rejects if `cancel(requestId)` is called. */
  createPending(requestId: string, timeoutMs: number): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          resolve({ approved: false, reason: 'timeout' });
        }
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  /** Resolve a pending request with a user response. Idempotent: the
   *  second call on the same requestId is a no-op. Calls on unknown
   *  requestIds are also no-ops (the caller may have timed out). */
  resolve(requestId: string, response: ApprovalResponse): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(response);
  }

  /** Reject a pending request. Used by server shutdown and explicit
   *  cancellation paths. */
  cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.reject(new Error(`approval request ${requestId} cancelled`));
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Reject every pending request and clear the map. Server shutdown
   *  calls this so in-flight turns don't dangle on a Promise that will
   *  never resolve. */
  disposeAll(): void {
    for (const requestId of Array.from(this.pending.keys())) {
      this.cancel(requestId);
    }
  }
}
