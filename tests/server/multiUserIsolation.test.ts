// Phase E T7 — END-TO-END multi-user isolation through the assembled app.
//
// The Phase E unit suites already prove module-level isolation: the path
// helpers namespace memory + learning under `users/{id}/…` (tests/memory/
// userScope.test.ts, learning path tests), and the route-layer cross-user 404
// matrix (tests/server/sessionOwnership.test.ts). What none of them prove is
// that the OWNER → NAMESPACE WIRING actually flows through a REAL turn: that a
// session stamped with `ownerId='alice'` causes `buildSessionContext` to scope
// BOTH the live learning observer AND the live memory manager under
// `<home>/users/alice/…`, end to end, when a turn runs via the gateway.
//
// This suite drives the real app (`buildAppWithRuntime(runtime, { principals })`
// + `app.request` with `Authorization: Bearer …`, MockProvider, an isolated
// temp HARNESS_HOME) and asserts the on-disk / observable consequences:
//   1. Session isolation (e2e) — re-proves the 404 matrix + per-owner listing
//      through the full app, complementing E-T4's route-level unit test.
//   2. Learning-namespace wiring — alice runs a tool-using turn; the observation
//      lands under `<home>/users/alice/learning/<projectId>/observations.jsonl`
//      and NOWHERE ELSE (not the legacy top-level, not bob's namespace).
//   3. Memory-namespace wiring — a distinctive MEMORY.md seeded in EACH of
//      alice's / bob's / the legacy namespace; alice's session prefetches ONLY
//      alice's content, bob's ONLY bob's, neither the legacy content.
//   4. Path-traversal — a `gateway.principals` id of `'../evil'` is rejected at
//      config parse (schema refinement) AND by `validatePrincipalId`.
//   5. Back-compat (e2e) — with NO principals, a tool-using turn writes its
//      observation + reads its memory under the LEGACY top-level paths, with no
//      ownership enforcement (byte-compatible with pre-Phase-E).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '../../src/config/schema.js';
import type { Message } from '../../src/core/types.js';
import { observationsPath } from '../../src/learning/paths.js';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';
import { replaceMemoryFile } from '../../src/memory/bounded.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses, peekBus } from '../../src/server/eventBus.js';
import { validatePrincipalId } from '../../src/server/principals.js';
import { buildRuntime } from '../../src/server/runtime.js';

const PRINCIPALS = [
  { id: 'alice', token: 'tok-a' },
  { id: 'bob', token: 'tok-b' },
];
const ALICE: Record<string, string> = { authorization: 'Bearer tok-a' };
const BOB: Record<string, string> = { authorization: 'Bearer tok-b' };
const JSON_HEADER = { 'Content-Type': 'application/json' };

/** A two-step scripted turn: the model calls Bash once (→ a learning
 *  observation is recorded for the dispatched tool), then ends with a text
 *  reply on the continuation call. Mirrors the toolUseScript pattern from
 *  the task-routing integration tests. */
function toolThenDoneScript(): void {
  MockProvider.toolUseScript = [
    { kind: 'tool_use', name: 'Bash', input: { command: 'echo hi' }, id: 'mui-tool-0' },
    { kind: 'text', text: 'done.' },
  ];
  MockProvider.resetScriptCursor();
}

function resetMockStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
}

describe('Phase E T7 — end-to-end multi-user isolation', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'e-t7-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'e-t7-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    resetMockStatics();
    __test_resetAllBuses();
    // getProjectId is cwd-keyed and process-cached. tmpCwd is fresh each test,
    // but reset defensively so a prior resolution can never bleed in.
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    resetMockStatics();
    __test_resetAllBuses();
    __test_resetProjectIdCache();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
  });

  async function buildPrincipalsApp(): Promise<{
    app: ReturnType<typeof buildAppWithRuntime>;
    runtime: Awaited<ReturnType<typeof buildRuntime>>;
  }> {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      model: 'mock-haiku',
      permissionMode: 'default',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime, { principals: PRINCIPALS });
    return { app, runtime };
  }

  /** Mint a session as the given principal and return its id. */
  async function createSessionAs(
    app: ReturnType<typeof buildAppWithRuntime>,
    headers: Record<string, string>,
  ): Promise<string> {
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { ...headers, ...JSON_HEADER },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string };
    return body.sessionId;
  }

  /** Drive a full tool-using turn for `sessionId` as the given principal and
   *  drain the per-turn SSE stream so the background turn completes (the
   *  events route closes on the turn terminal when there's no `?follow`). */
  async function runTurnAs(
    app: ReturnType<typeof buildAppWithRuntime>,
    headers: Record<string, string>,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { ...headers, ...JSON_HEADER },
      body: JSON.stringify({ text }),
    });
    expect(turnRes.status).toBe(202);
    const eventsRes = await app.request(`/sessions/${sessionId}/events`, { headers });
    expect(eventsRes.status).toBe(200);
    await eventsRes.text();
  }

  // --- 1. Session isolation (e2e) -----------------------------------------

  test('session isolation — bob 404s on alice every route; listing is per-owner', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      toolThenDoneScript();
      const aliceSession = await createSessionAs(app, ALICE);
      // Run a real turn so the session is fully live (bus minted, messages
      // persisted) — the 404s below are NOT because the session is inert.
      await runTurnAs(app, ALICE, aliceSession, 'run echo hi');

      // alice's own turn persisted at least the assistant message.
      expect(runtime.sessionDb.loadMessages(aliceSession).length).toBeGreaterThan(0);

      // Cross-user negatives — bob gets 404 on every per-session route.
      const get = await app.request(`/sessions/${aliceSession}`, { headers: BOB });
      expect(get.status).toBe(404);

      const messages = await app.request(`/sessions/${aliceSession}/messages`, { headers: BOB });
      expect(messages.status).toBe(404);

      const turns = await app.request(`/sessions/${aliceSession}/turns`, {
        method: 'POST',
        headers: { ...BOB, ...JSON_HEADER },
        body: JSON.stringify({ text: 'intrude' }),
      });
      expect(turns.status).toBe(404);

      const events = await app.request(`/sessions/${aliceSession}/events`, { headers: BOB });
      expect(events.status).toBe(404);

      const del = await app.request(`/sessions/${aliceSession}`, {
        method: 'DELETE',
        headers: BOB,
      });
      expect(del.status).toBe(404);

      // Side-effect safety — bob's rejected DELETE left alice's row intact and
      // bob's rejected /turns never appended a message.
      expect(runtime.sessionDb.getSession(aliceSession)).not.toBeNull();
      const afterIntrusion = runtime.sessionDb.loadMessages(aliceSession).length;

      // GET /sessions is per-owner: alice sees hers, bob does not.
      const aliceList = await app.request('/sessions', { headers: ALICE });
      const aliceBody = (await aliceList.json()) as { sessions: Array<{ sessionId: string }> };
      expect(aliceBody.sessions.some((s) => s.sessionId === aliceSession)).toBe(true);

      const bobList = await app.request('/sessions', { headers: BOB });
      const bobBody = (await bobList.json()) as { sessions: Array<{ sessionId: string }> };
      expect(bobBody.sessions.some((s) => s.sessionId === aliceSession)).toBe(false);

      // Re-assert no message was appended by bob's rejected turn (compare to
      // the snapshot taken right after the intrusion attempts).
      expect(runtime.sessionDb.loadMessages(aliceSession).length).toBe(afterIntrusion);
    } finally {
      await runtime.dispose();
    }
  });

  // --- 2. Learning-namespace wiring (the key e2e proof) -------------------

  test('learning wiring — alice tool turn writes observations under users/alice ONLY', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      toolThenDoneScript();
      const aliceSession = await createSessionAs(app, ALICE);
      await runTurnAs(app, ALICE, aliceSession, 'run echo hi');

      // Dispose the session to flush the observer's async write chain.
      await runtime.disposeSession(aliceSession);

      const projectId = getProjectId(tmpCwd).id;
      const aliceObs = observationsPath(tmpHome, projectId, 'alice');
      const legacyObs = observationsPath(tmpHome, projectId); // no userId
      const bobObs = observationsPath(tmpHome, projectId, 'bob');

      // The observation landed under alice's per-user learning namespace.
      expect(existsSync(aliceObs)).toBe(true);
      const content = readFileSync(aliceObs, 'utf8');
      expect(content).toContain('"tool_name":"Bash"');

      // And NOWHERE else — not the legacy top-level corpus, not bob's.
      expect(existsSync(legacyObs)).toBe(false);
      expect(existsSync(bobObs)).toBe(false);
      // Defensive: the legacy `learning/` dir tree was never created at all.
      expect(existsSync(join(tmpHome, 'learning', projectId))).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test('learning wiring — alice and bob turns write to disjoint namespaces', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      toolThenDoneScript();
      const aliceSession = await createSessionAs(app, ALICE);
      await runTurnAs(app, ALICE, aliceSession, 'run echo hi');
      await runtime.disposeSession(aliceSession);

      // bob runs his own tool turn (re-arm the script — alice consumed it).
      toolThenDoneScript();
      const bobSession = await createSessionAs(app, BOB);
      await runTurnAs(app, BOB, bobSession, 'run echo hi');
      await runtime.disposeSession(bobSession);

      const projectId = getProjectId(tmpCwd).id;
      // Each user's observation lands strictly under their own namespace.
      expect(existsSync(observationsPath(tmpHome, projectId, 'alice'))).toBe(true);
      expect(existsSync(observationsPath(tmpHome, projectId, 'bob'))).toBe(true);
      // Cross-namespace: neither user's corpus leaked into the other or legacy.
      expect(existsSync(observationsPath(tmpHome, projectId))).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  // --- 3. Memory-namespace wiring (e2e) -----------------------------------

  test('memory wiring — each session prefetches ONLY its owner namespace', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      // Seed a DISTINCTIVE MEMORY.md in each namespace BEFORE any turn so the
      // memory manager (built lazily on first getSessionContext) reads it.
      replaceMemoryFile('MEMORY.md', 'ALICE-SECRET-MEMORY', tmpHome, 'alice');
      replaceMemoryFile('MEMORY.md', 'BOB-SECRET-MEMORY', tmpHome, 'bob');
      replaceMemoryFile('MEMORY.md', 'LEGACY-SHARED-MEMORY', tmpHome); // no userId

      // Mint a session per principal so each resolves a userId-scoped context.
      const aliceSession = await createSessionAs(app, ALICE);
      const bobSession = await createSessionAs(app, BOB);

      // The session contexts route memory through the owner's namespace.
      const aliceCtx = runtime.getSessionContext(aliceSession);
      const bobCtx = runtime.getSessionContext(bobSession);
      expect(aliceCtx.userId).toBe('alice');
      expect(bobCtx.userId).toBe('bob');

      // Probe the live memory observable each turn uses: prefetchSnapshot is
      // what query() injects into the latest user message. alice sees alice's
      // memory and NEVER bob's or the legacy content.
      const aliceSnap = await aliceCtx.memoryManager.prefetchSnapshot('hi');
      expect(aliceSnap).toContain('ALICE-SECRET-MEMORY');
      expect(aliceSnap).not.toContain('BOB-SECRET-MEMORY');
      expect(aliceSnap).not.toContain('LEGACY-SHARED-MEMORY');

      const bobSnap = await bobCtx.memoryManager.prefetchSnapshot('hi');
      expect(bobSnap).toContain('BOB-SECRET-MEMORY');
      expect(bobSnap).not.toContain('ALICE-SECRET-MEMORY');
      expect(bobSnap).not.toContain('LEGACY-SHARED-MEMORY');
    } finally {
      await runtime.dispose();
    }
  });

  test('memory wiring — injected MEMORY block reaches the provider under owner scope', async () => {
    // Stronger e2e: prove the owner-scoped memory is actually injected into the
    // message the provider sees on a live turn (not just readable off the
    // manager). The default Hello-world MockProvider snapshots req.messages, so
    // we assert the injected <MEMORY.md> block carries ALICE's content only.
    const { app, runtime } = await buildPrincipalsApp();
    try {
      replaceMemoryFile('MEMORY.md', 'ALICE-INJECTED-MEMORY', tmpHome, 'alice');
      replaceMemoryFile('MEMORY.md', 'BOB-INJECTED-MEMORY', tmpHome, 'bob');

      const aliceSession = await createSessionAs(app, ALICE);
      MockProvider.lastMessages = undefined;
      await runTurnAs(app, ALICE, aliceSession, 'hello alice');

      const msgs: Message[] = MockProvider.lastMessages ?? [];
      expect(msgs.length).toBeGreaterThan(0);
      // Flatten the text the provider received for the turn.
      const text = msgs
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain('ALICE-INJECTED-MEMORY');
      expect(text).not.toContain('BOB-INJECTED-MEMORY');
    } finally {
      await runtime.dispose();
    }
  });

  // --- 4. Path-traversal --------------------------------------------------

  test('path-traversal — a traversal principal id is rejected at config parse', async () => {
    // The schema refinement on gateway.principals rejects any id that isn't a
    // filesystem-safe segment. `../evil` and `a/b` both carry separators.
    expect(() =>
      SettingsSchema.parse({
        gateway: { principals: [{ id: '../evil', token: 'tok-x' }] },
      }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({
        gateway: { principals: [{ id: 'a/b', token: 'tok-y' }] },
      }),
    ).toThrow();
    // A well-formed id parses cleanly (control: the rejection is about the id,
    // not the surrounding shape).
    expect(() =>
      SettingsSchema.parse({
        gateway: { principals: [{ id: 'alice', token: 'tok-ok' }] },
      }),
    ).not.toThrow();
  });

  test('path-traversal — validatePrincipalId throws on traversal segments', async () => {
    expect(() => validatePrincipalId('../evil')).toThrow();
    expect(() => validatePrincipalId('a/b')).toThrow();
    expect(() => validatePrincipalId('alice')).not.toThrow();
  });

  // --- 5. Back-compat (e2e) ------------------------------------------------

  test('back-compat — no principals: turn writes observation + memory to LEGACY paths, no enforcement', async () => {
    // No principals, no auth — the open loopback path. Byte-compatible with
    // pre-Phase-E: ownerId null → userId undefined → legacy top-level paths.
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      model: 'mock-haiku',
      permissionMode: 'default',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime);
    try {
      // Seed legacy MEMORY.md; with no userId the manager reads it.
      replaceMemoryFile('MEMORY.md', 'LEGACY-ONLY-MEMORY', tmpHome);

      toolThenDoneScript();
      const create = await app.request('/sessions', {
        method: 'POST',
        headers: JSON_HEADER,
        body: JSON.stringify({}),
      });
      expect(create.status).toBe(201);
      const { sessionId } = (await create.json()) as { sessionId: string };
      // No owner stamped — implicit single-principal / open mode.
      expect(runtime.sessionDb.getSession(sessionId)?.ownerId).toBeNull();

      // The session context has no userId → legacy memory scope.
      const ctx = runtime.getSessionContext(sessionId);
      expect(ctx.userId).toBeUndefined();
      const snap = await ctx.memoryManager.prefetchSnapshot('hi');
      expect(snap).toContain('LEGACY-ONLY-MEMORY');

      await runTurnAs(app, {}, sessionId, 'run echo hi');
      await runtime.disposeSession(sessionId);

      const projectId = getProjectId(tmpCwd).id;
      // Observation lands under the LEGACY top-level corpus, NOT under any
      // users/ namespace.
      expect(existsSync(observationsPath(tmpHome, projectId))).toBe(true);
      const content = readFileSync(observationsPath(tmpHome, projectId), 'utf8');
      expect(content).toContain('"tool_name":"Bash"');
      // The per-user tree was never created.
      expect(existsSync(join(tmpHome, 'users'))).toBe(false);

      // No ownership enforcement — any no-auth caller can GET the session and
      // it appears in the unfiltered listing.
      const get = await app.request(`/sessions/${sessionId}`);
      expect(get.status).toBe(200);
      const list = await app.request('/sessions');
      const body = (await list.json()) as { sessions: Array<{ sessionId: string }> };
      expect(body.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  test('back-compat — single-token mode: owner null, observation under legacy path', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      model: 'mock-haiku',
      permissionMode: 'default',
      preflight: false,
    });
    const app = buildAppWithRuntime(runtime, { auth: 'legacy-secret' });
    const LEGACY: Record<string, string> = { authorization: 'Bearer legacy-secret' };
    try {
      toolThenDoneScript();
      const create = await app.request('/sessions', {
        method: 'POST',
        headers: { ...LEGACY, ...JSON_HEADER },
        body: JSON.stringify({}),
      });
      expect(create.status).toBe(201);
      const { sessionId } = (await create.json()) as { sessionId: string };
      // Single-token has no principal id → owner null → legacy scope.
      expect(runtime.sessionDb.getSession(sessionId)?.ownerId).toBeNull();

      await runTurnAs(app, LEGACY, sessionId, 'run echo hi');
      await runtime.disposeSession(sessionId);

      const projectId = getProjectId(tmpCwd).id;
      expect(existsSync(observationsPath(tmpHome, projectId))).toBe(true);
      expect(existsSync(join(tmpHome, 'users'))).toBe(false);
      // peekBus was reclaimed on disposeSession (no leak).
      expect(peekBus(sessionId)).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});
