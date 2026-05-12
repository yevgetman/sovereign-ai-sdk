# Phase 16.0a — Daemon Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the daemon infrastructure — channel types, session cache, approval queue, typed event bus, daemon runner, and `harness daemon` CLI command — as a headless-testable foundation for the Phase 16.0b Ink TUI.

**Architecture:** The daemon is a profile-scoped long-running process that owns a typed in-process event bus, an LRU session cache (session key → session ID), an approval queue for pending permission requests, and reuses Phase 13.2's TaskManager for background task supervision. `harness daemon` acquires the Phase 10.7 PID lock (one daemon per profile), writes lifecycle events to the event bus, logs startup to stderr, and stays alive until SIGTERM/SIGINT. Phase 16.0b wires the Ink TUI as the foreground client of this bus.

**Tech Stack:** TypeScript strict, Bun, Node `EventEmitter`, existing `tryAcquireLock`/`readLockInfo` from `src/config/profileLock.ts`, `resolveHarnessHome` from `src/config/paths.ts`, `@commander-js/extra-typings`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/channels/types.ts` | Create | `InboundMessage`, `Attachment`, `DeliveryResult`, `SecretTarget`, `ChannelAdapter` types |
| `src/channels/sessionKey.ts` | Create | `buildSessionKey(msg): string` |
| `src/channels/delivery.ts` | Create | `send(target, content, harnessHome?): Promise<DeliveryResult>` + local outbox |
| `src/daemon/types.ts` | Create | `DaemonEvent` union, `DaemonEventType`, `DaemonEventMap`, `DaemonHandle` |
| `src/daemon/eventBus.ts` | Create | `DaemonEventBus` — typed wrapper over Node `EventEmitter` |
| `src/daemon/sessionCache.ts` | Create | `SessionCache` — LRU `Map<key, CacheEntry>` |
| `src/daemon/approvalQueue.ts` | Create | `ApprovalQueue` — enqueue/dequeue/pending/expireStale |
| `src/daemon/runner.ts` | Create | `startDaemon(opts?)` — acquires lock, inits services, returns `DaemonHandle` |
| `src/main.ts` | Modify | Add `daemon` top-level command |
| `tests/channels/sessionKey.test.ts` | Create | 3 tests for `buildSessionKey` |
| `tests/channels/delivery.test.ts` | Create | 2 tests for `send` |
| `tests/daemon/eventBus.test.ts` | Create | 3 tests for `DaemonEventBus` |
| `tests/daemon/sessionCache.test.ts` | Create | 5 tests for `SessionCache` LRU behaviour |
| `tests/daemon/approvalQueue.test.ts` | Create | 5 tests for `ApprovalQueue` |
| `tests/daemon/runner.test.ts` | Create | 4 tests for `startDaemon` PID-lock lifecycle |

---

### Task 1: Channel types, session key, and local delivery

**Files:**
- Create: `src/channels/types.ts`
- Create: `src/channels/sessionKey.ts`
- Create: `src/channels/delivery.ts`
- Create: `tests/channels/sessionKey.test.ts`
- Create: `tests/channels/delivery.test.ts`

---

- [ ] **Step 1: Write failing tests for `buildSessionKey` and `send`**

`tests/channels/sessionKey.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { buildSessionKey } from '../../src/channels/sessionKey.js';

describe('buildSessionKey', () => {
  test('private DM without threadId', () => {
    const key = buildSessionKey({
      sender: 'user1',
      channel: 'local',
      chatId: 'chat123',
      chatType: 'private',
      text: 'hello',
    });
    expect(key).toBe('agent:main:local:private:chat123');
  });

  test('includes threadId when present', () => {
    const key = buildSessionKey({
      sender: 'user1',
      channel: 'telegram',
      chatId: 'chat456',
      chatType: 'group',
      threadId: 'thread789',
      text: 'hi',
    });
    expect(key).toBe('agent:main:telegram:group:chat456:thread789');
  });

  test('chatType distinguishes keys for same chatId', () => {
    const base = { sender: 'u', channel: 'slack', chatId: 'c', text: 't' };
    expect(buildSessionKey({ ...base, chatType: 'private' })).not.toBe(
      buildSessionKey({ ...base, chatType: 'channel' }),
    );
  });
});
```

`tests/channels/delivery.test.ts`:

```typescript
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { send } from '../../src/channels/delivery.js';

describe('send', () => {
  const toClean: string[] = [];
  afterEach(() => {
    for (const d of toClean) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    toClean.length = 0;
  });

  function tmpHome(): string {
    const d = mkdtempSync(join(tmpdir(), 'sov-delivery-'));
    toClean.push(d);
    return d;
  }

  test('local target writes content to outbox/local/', async () => {
    const home = tmpHome();
    const result = await send('local', 'hello world', home);
    expect(result.ok).toBe(true);
    const files = readdirSync(join(home, 'outbox', 'local'));
    expect(files.length).toBe(1);
    const content = readFileSync(join(home, 'outbox', 'local', files[0]!), 'utf8');
    expect(content).toBe('hello world');
  });

  test('unknown target returns error result', async () => {
    const result = await send('telegram', 'hello', '/tmp');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown delivery target');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (modules not found)**

```bash
cd /Users/julie/code/sovereign-ai-harness
bun test tests/channels/ 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../../src/channels/sessionKey.js'`

- [ ] **Step 3: Create `src/channels/types.ts`**

```typescript
// Channel adapter contract. Thin type-only module — concrete adapters
// (Telegram, Slack) are Phase 16.5+ deliverables.

export type Attachment = {
  type: 'image' | 'file' | 'audio' | 'video';
  url: string;
  name?: string;
  mimeType?: string;
};

export type InboundMessage = {
  sender: string;
  channel: string;
  chatId: string;
  chatType: 'private' | 'channel' | 'group';
  threadId?: string;
  text: string;
  attachments?: Attachment[];
  raw?: unknown;
};

export type DeliveryResult = {
  ok: boolean;
  error?: string;
};

export type SecretTarget = {
  key: string;
  type: 'env' | 'inline' | 'secret-uri';
  required: boolean;
  included: 'always' | 'if-configured';
};

/** Minimal ChannelAdapter shell. Full optional-method contract
 *  (outbound, monitor, setup, auth, etc.) deferred to Phase 16.5+. */
export type ChannelAdapter = {
  id: string;
  secretTargets?: SecretTarget[];
};
```

- [ ] **Step 4: Create `src/channels/sessionKey.ts`**

```typescript
// Deterministic session key. Used as DB primary key, LRU cache key,
// and delivery target key. Invariant #8 from harness design principles.

import type { InboundMessage } from './types.js';

export function buildSessionKey(msg: InboundMessage): string {
  const parts = ['agent', 'main', msg.channel, msg.chatType, msg.chatId];
  if (msg.threadId !== undefined) parts.push(msg.threadId);
  return parts.join(':');
}
```

- [ ] **Step 5: Create `src/channels/delivery.ts`**

```typescript
// Delivery abstraction. Routes the 'local' target to the outbox filesystem.
// Future adapters register here when Phase 16.5+ channel adapters land.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHarnessHome } from '../config/paths.js';
import type { DeliveryResult } from './types.js';

export async function send(
  target: string,
  content: string,
  harnessHome: string = resolveHarnessHome(),
): Promise<DeliveryResult> {
  if (target !== 'local') {
    return { ok: false, error: `unknown delivery target: ${target}` };
  }
  try {
    const outboxDir = join(harnessHome, 'outbox', 'local');
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(join(outboxDir, `${Date.now()}.txt`), content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 6: Run tests — expect PASS**

```bash
bun test tests/channels/ 2>&1 | tail -10
```

Expected: 5 pass, 0 fail.

- [ ] **Step 7: Lint + typecheck**

```bash
bun run lint 2>&1 | grep -E "error|Error" | head -10
bun run typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/channels/ tests/channels/
git commit -m "feat(channels): types, session key, and local delivery"
```

---

### Task 2: Session cache

**Files:**
- Create: `src/daemon/sessionCache.ts`
- Create: `tests/daemon/sessionCache.test.ts`

---

- [ ] **Step 1: Write failing tests**

`tests/daemon/sessionCache.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { SessionCache } from '../../src/daemon/sessionCache.js';

describe('SessionCache', () => {
  test('get returns undefined for missing key', () => {
    const cache = new SessionCache(8);
    expect(cache.get('missing')).toBeUndefined();
  });

  test('set and get round-trip', () => {
    const cache = new SessionCache(8);
    cache.set('k1', 'sess-abc');
    const entry = cache.get('k1');
    expect(entry?.sessionId).toBe('sess-abc');
    expect(entry?.lastActive).toBeInstanceOf(Date);
  });

  test('evicts oldest entry when maxSize reached', () => {
    const cache = new SessionCache(2);
    cache.set('k1', 's1');
    cache.set('k2', 's2');
    cache.set('k3', 's3'); // evicts k1 (oldest)
    expect(cache.has('k1')).toBe(false);
    expect(cache.has('k2')).toBe(true);
    expect(cache.has('k3')).toBe(true);
    expect(cache.size).toBe(2);
  });

  test('get refreshes LRU order — accessed entry survives next eviction', () => {
    const cache = new SessionCache(2);
    cache.set('k1', 's1');
    cache.set('k2', 's2');
    cache.get('k1'); // refresh k1 → k2 becomes oldest
    cache.set('k3', 's3'); // evicts k2
    expect(cache.has('k1')).toBe(true);
    expect(cache.has('k2')).toBe(false);
    expect(cache.has('k3')).toBe(true);
  });

  test('delete removes entry and returns true; missing key returns false', () => {
    const cache = new SessionCache(8);
    cache.set('k1', 's1');
    expect(cache.delete('k1')).toBe(true);
    expect(cache.has('k1')).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.delete('nonexistent')).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/daemon/sessionCache.test.ts 2>&1 | tail -8
```

Expected: FAIL — `Cannot find module '../../src/daemon/sessionCache.js'`

- [ ] **Step 3: Create `src/daemon/sessionCache.ts`**

```typescript
// LRU session cache. Maps session keys → active session IDs.
// Evicts the least-recently-used entry when the cache exceeds maxSize.
// A Map preserves insertion order; delete + re-insert on access = O(1) LRU.

export type CacheEntry = {
  readonly sessionId: string;
  readonly lastActive: Date;
};

export class SessionCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly maxSize: number = 32) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    // Refresh LRU position.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  set(key: string, sessionId: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { sessionId, lastActive: new Date() });
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }

  entries(): IterableIterator<[string, CacheEntry]> {
    return this.cache.entries();
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bun test tests/daemon/sessionCache.test.ts 2>&1 | tail -8
```

Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/sessionCache.ts tests/daemon/sessionCache.test.ts
git commit -m "feat(daemon): LRU session cache"
```

---

### Task 3: Approval queue

**Files:**
- Create: `src/daemon/approvalQueue.ts`
- Create: `tests/daemon/approvalQueue.test.ts`

---

- [ ] **Step 1: Write failing tests**

`tests/daemon/approvalQueue.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/daemon/approvalQueue.test.ts 2>&1 | tail -8
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/daemon/approvalQueue.ts`**

```typescript
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
```

- [ ] **Step 4: Run — expect PASS**

```bash
bun test tests/daemon/approvalQueue.test.ts 2>&1 | tail -8
```

Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvalQueue.ts tests/daemon/approvalQueue.test.ts
git commit -m "feat(daemon): approval queue with TTL expiry"
```

---

### Task 4: Daemon event bus

**Files:**
- Create: `src/daemon/types.ts`
- Create: `src/daemon/eventBus.ts`
- Create: `tests/daemon/eventBus.test.ts`

---

- [ ] **Step 1: Write failing tests**

`tests/daemon/eventBus.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { DaemonEventBus } from '../../src/daemon/eventBus.js';

describe('DaemonEventBus', () => {
  test('on + emit delivers typed event to handler', () => {
    const bus = new DaemonEventBus();
    const received: number[] = [];
    bus.on('daemon_started', (e) => received.push(e.pid));
    bus.emit({ type: 'daemon_started', pid: 42, profile: 'default', harnessHome: '/tmp' });
    expect(received).toEqual([42]);
  });

  test('off removes handler — no more deliveries after off', () => {
    const bus = new DaemonEventBus();
    const log: string[] = [];
    const handler = (e: { type: 'daemon_stopping'; reason: string }) =>
      log.push(e.reason);
    bus.on('daemon_stopping', handler);
    bus.off('daemon_stopping', handler);
    bus.emit({ type: 'daemon_stopping', reason: 'explicit' });
    expect(log).toHaveLength(0);
  });

  test('multiple handlers for same event type all fire in registration order', () => {
    const bus = new DaemonEventBus();
    const order: number[] = [];
    bus.on('daemon_stopping', () => order.push(1));
    bus.on('daemon_stopping', () => order.push(2));
    bus.emit({ type: 'daemon_stopping', reason: 'explicit' });
    expect(order).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/daemon/eventBus.test.ts 2>&1 | tail -8
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Create `src/daemon/types.ts`**

```typescript
// Daemon event types — the union of all events the daemon bus can carry.
// The TUI (Phase 16.0b) subscribes to these to update its display.

export type DaemonEvent =
  | { type: 'daemon_started'; pid: number; profile: string; harnessHome: string }
  | { type: 'daemon_stopping'; reason: 'sigterm' | 'sigint' | 'error' | 'explicit' }
  | { type: 'task_update'; taskId: string; state: string }
  | { type: 'approval_requested'; requestId: string; tool: string; input: unknown }
  | { type: 'approval_resolved'; requestId: string; approved: boolean }
  | { type: 'session_cached'; sessionKey: string; sessionId: string }
  | { type: 'session_evicted'; sessionKey: string; sessionId: string };

export type DaemonEventType = DaemonEvent['type'];

/** Maps each event `type` literal to the full event shape. */
export type DaemonEventMap = {
  [E in DaemonEvent as E['type']]: E;
};
```

- [ ] **Step 4: Create `src/daemon/eventBus.ts`**

```typescript
// Typed event bus. Wraps Node's EventEmitter with a type-safe API that
// narrows the event payload to the specific DaemonEvent variant by key.

import { EventEmitter } from 'node:events';
import type { DaemonEvent, DaemonEventMap, DaemonEventType } from './types.js';

export class DaemonEventBus {
  private readonly emitter = new EventEmitter();

  on<T extends DaemonEventType>(
    type: T,
    handler: (event: DaemonEventMap[T]) => void,
  ): this {
    this.emitter.on(type, handler);
    return this;
  }

  off<T extends DaemonEventType>(
    type: T,
    handler: (event: DaemonEventMap[T]) => void,
  ): this {
    this.emitter.off(type, handler);
    return this;
  }

  emit(event: DaemonEvent): void {
    this.emitter.emit(event.type, event);
  }
}
```

- [ ] **Step 5: Run — expect PASS**

```bash
bun test tests/daemon/eventBus.test.ts 2>&1 | tail -8
```

Expected: 3 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/types.ts src/daemon/eventBus.ts tests/daemon/eventBus.test.ts
git commit -m "feat(daemon): typed event bus"
```

---

### Task 5: Daemon runner + `harness daemon` CLI command

**Files:**
- Create: `src/daemon/runner.ts`
- Modify: `src/main.ts` (add `daemon` command before the final `program.parseAsync` call)
- Create: `tests/daemon/runner.test.ts`

Context about existing infrastructure:
- `tryAcquireLock(home?: string): LockHandle | null` — from `src/config/profileLock.ts`; acquires the `.sov.lock/` directory lock for `home`; returns `null` if already held by an alive process.
- `readLockInfo(home?: string): LockInfo` — from same file; reads `{ held, pid?, alive? }`.
- `resolveHarnessHome()` — from `src/config/paths.js`; returns `$HARNESS_HOME ?? ~/.harness`.
- The daemon command goes in the top-level `program` in `src/main.ts`, alongside `chat`, `config`, `profile`, etc.

---

- [ ] **Step 1: Write failing tests**

`tests/daemon/runner.test.ts`:

```typescript
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon } from '../../src/daemon/runner.js';

describe('startDaemon', () => {
  const toClean: string[] = [];
  afterEach(() => {
    for (const d of toClean) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    toClean.length = 0;
  });
  function tmpHome(): string {
    const d = mkdtempSync(join(tmpdir(), 'sov-runner-'));
    toClean.push(d);
    return d;
  }

  test('returns handle with bus, sessionCache, approvalQueue', () => {
    const home = tmpHome();
    const handle = startDaemon({ harnessHome: home });
    expect(handle.bus).toBeDefined();
    expect(handle.sessionCache).toBeDefined();
    expect(handle.approvalQueue).toBeDefined();
    handle.shutdown();
  });

  test('throws with "daemon already running" when lock is held', () => {
    const home = tmpHome();
    const h1 = startDaemon({ harnessHome: home });
    try {
      expect(() => startDaemon({ harnessHome: home })).toThrow('daemon already running');
    } finally {
      h1.shutdown();
    }
  });

  test('can start again after shutdown releases the lock', () => {
    const home = tmpHome();
    const h1 = startDaemon({ harnessHome: home });
    h1.shutdown();
    const h2 = startDaemon({ harnessHome: home });
    h2.shutdown();
    // No throw = lock was released and re-acquired successfully.
  });

  test('shutdown emits daemon_stopping on the bus', () => {
    const home = tmpHome();
    const handle = startDaemon({ harnessHome: home });
    const reasons: string[] = [];
    handle.bus.on('daemon_stopping', (e) => reasons.push(e.reason));
    handle.shutdown();
    expect(reasons).toEqual(['explicit']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/daemon/runner.test.ts 2>&1 | tail -8
```

Expected: FAIL — `Cannot find module '../../src/daemon/runner.js'`

- [ ] **Step 3: Create `src/daemon/runner.ts`**

```typescript
// Daemon bootstrap. Acquires the profile PID lock, initialises background
// services, and returns a handle for graceful shutdown. Keeps no global
// state — the caller owns the handle lifetime.

import { readLockInfo, tryAcquireLock } from '../config/profileLock.js';
import { resolveHarnessHome } from '../config/paths.js';
import { ApprovalQueue } from './approvalQueue.js';
import { DaemonEventBus } from './eventBus.js';
import { SessionCache } from './sessionCache.js';
import type { ApprovalQueue as ApprovalQueueType } from './approvalQueue.js';
import type { SessionCache as SessionCacheType } from './sessionCache.js';
import type { DaemonEventBus as DaemonEventBusType } from './eventBus.js';

export type DaemonHandle = {
  readonly bus: DaemonEventBusType;
  readonly sessionCache: SessionCacheType;
  readonly approvalQueue: ApprovalQueueType;
  shutdown(): void;
};

export type StartDaemonOpts = {
  harnessHome?: string;
  sessionCacheSize?: number;
  approvalTtlMs?: number;
};

export function startDaemon(opts: StartDaemonOpts = {}): DaemonHandle {
  const home = opts.harnessHome ?? resolveHarnessHome();

  const lock = tryAcquireLock(home);
  if (!lock) {
    const info = readLockInfo(home);
    throw new Error(
      `daemon already running for this profile (PID ${info.pid ?? 'unknown'})`,
    );
  }

  const bus = new DaemonEventBus();
  const sessionCache = new SessionCache(opts.sessionCacheSize ?? 32);
  const approvalQueue = new ApprovalQueue(opts.approvalTtlMs);

  bus.emit({
    type: 'daemon_started',
    pid: process.pid,
    profile: home,
    harnessHome: home,
  });

  function shutdown(): void {
    bus.emit({ type: 'daemon_stopping', reason: 'explicit' });
    lock.release();
  }

  return { bus, sessionCache, approvalQueue, shutdown };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bun test tests/daemon/runner.test.ts 2>&1 | tail -8
```

Expected: 4 pass, 0 fail.

- [ ] **Step 5: Add `daemon` command to `src/main.ts`**

Find the block near the end of the `main()` function (just before `await program.parseAsync(argv)`) and add:

```typescript
  program
    .command('daemon')
    .description('Start the harness daemon for the active profile.')
    .action(async () => {
      const { startDaemon } = await import('./daemon/runner.js');
      let handle: ReturnType<typeof startDaemon> | null = null;
      try {
        handle = startDaemon();
        process.stderr.write(
          `[daemon] started (PID ${process.pid})\n`,
        );
        const stop = (): void => {
          handle?.shutdown();
          process.exit(0);
        };
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
        // Keep the Bun event loop alive until a signal fires.
        await new Promise<never>(() => {});
      } catch (err) {
        process.stderr.write(
          `[daemon] ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });
```

The correct location: look for `await program.parseAsync(argv);` (the last statement in the `main()` function, currently around line 520). Place the new `.command('daemon')` block before that line, after the `mission init` command block.

- [ ] **Step 6: Lint + typecheck + full suite**

```bash
bun run lint 2>&1 | grep -E "^.*error" | head -10
bun run typecheck 2>&1 | tail -10
bun run test 2>&1 | tail -8
```

Expected: lint clean (2 pre-existing warnings in shellSemantics.ts are fine), typecheck clean, all tests pass. Test count should be 1783 (baseline) + 5 (sessionKey + delivery) + 5 (sessionCache) + 5 (approvalQueue) + 3 (eventBus) + 4 (runner) = **1805/1805**.

- [ ] **Step 7: Smoke test the CLI**

```bash
# Verify daemon command appears in help
bun src/main.ts --help 2>&1 | grep daemon

# Verify PID lock collision error message
HARNESS_HOME=/tmp/sov-daemon-smoke bun src/main.ts daemon &
DAEMON_PID=$!
sleep 0.3
HARNESS_HOME=/tmp/sov-daemon-smoke bun src/main.ts daemon 2>&1
kill $DAEMON_PID 2>/dev/null
rm -rf /tmp/sov-daemon-smoke
```

Expected first command: `daemon   Start the harness daemon for the active profile.`
Expected second (collision): `[daemon] daemon already running for this profile (PID <N>)`

- [ ] **Step 8: Commit**

```bash
git add src/daemon/runner.ts src/main.ts tests/daemon/runner.test.ts
git commit -m "feat(daemon): runner + harness daemon CLI command"
```

---

## After all tasks

```bash
bun run lint && bun run typecheck && bun run test
git push origin master
sov upgrade
```

---

## Self-review

**Spec coverage (Phase 16.0 items this plan implements):**
- ✅ Item 1 partial: `startDaemon()` — PID lock, event bus, services init. (Full daemon runner with TaskManager integration is Phase 16.0b)
- ✅ Item 8: `src/channels/types.ts` — `ChannelAdapter` type shell
- ✅ Item 9: `src/channels/types.ts` — `InboundMessage` type
- ✅ Item 10: `src/channels/sessionKey.ts` — `buildSessionKey()`
- ✅ Item 12: `src/channels/delivery.ts` — `send()` + local outbox
- ✅ Item 13: `src/channels/types.ts` — `SecretTarget` type
- ✅ Item 14: `src/main.ts` — `harness daemon` command with PID lock enforcement
- ✅ Bonus: session cache (LRU, item 4 shape) and approval queue (item 3 shape)

**Items deferred to Phase 16.0b:**
- Item 2: Worker supervisor (TaskManager integration into daemon loop)
- Item 5: Daemon-level compression threshold
- Item 6: Ink TUI
- Item 7: Local delivery target in TUI rendering
- Item 11: Full COMMAND_REGISTRY promotion

**Placeholder scan:** None. Every step has actual code.

**Type consistency:** `DaemonHandle` in `runner.ts` uses concrete class types (`SessionCache`, `ApprovalQueue`, `DaemonEventBus`) — avoiding circular import by importing type aliases alongside class imports. `InboundMessage` in `delivery.ts` is not imported (function takes `string` target, not `InboundMessage`) — correct, delivery is target-string–based.
