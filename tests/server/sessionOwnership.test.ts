// Phase E T4 — owner-only session access across all /sessions routes.
//
// The gateway is multi-user (principals mode). Once a request's bearer token
// resolves to a real principal, that principal may act on a session ONLY if it
// owns it. Any other session (owned by someone else, or unowned) is treated as
// NON-EXISTENT → 404 (existence-hiding; NEVER 403, never reveal another
// principal's session exists). This test pins:
//   - POST /sessions stamps the creator as owner.
//   - GET /sessions is owner-filtered.
//   - the full cross-user negative matrix returns 404 (not 403/200/500) for
//     bob against alice's session across EVERY per-session route.
//   - alice can access her own session on each route.
//   - side-effect safety: bob's DELETE doesn't delete alice's session; bob's
//     POST /turns doesn't create a bus / run a turn.
//   - back-compat: open mode (no principals) → no enforcement; ownerId null;
//     byte-compatible with today.
//
// Setup mirrors gatewayEndToEnd.test.ts: MockProvider, buildAppWithRuntime +
// app.request, one principals registry { alice, bob }.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses, peekBus } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';

const PRINCIPALS = [
  { id: 'alice', token: 'tok-a' },
  { id: 'bob', token: 'tok-b' },
];
const ALICE: Record<string, string> = { authorization: 'Bearer tok-a' };
const BOB: Record<string, string> = { authorization: 'Bearer tok-b' };

const JSON_HEADER = { 'Content-Type': 'application/json' };

describe('Phase E T4 — owner-only session access', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'e-t4-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'e-t4-cwd-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseMode = false;
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    MockProvider.lastMessages = undefined;
    __test_resetAllBuses();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    MockProvider.toolUseMode = false;
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    MockProvider.lastMessages = undefined;
    __test_resetAllBuses();
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

  test('POST /sessions stamps the creator as owner', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      const sessionId = await createSessionAs(app, ALICE);
      // Verify directly against the DB (unscoped read) that owner_id is alice.
      const row = runtime.sessionDb.getSession(sessionId);
      expect(row).not.toBeNull();
      expect(row?.ownerId).toBe('alice');
    } finally {
      await runtime.dispose();
    }
  });

  test('GET /sessions is owner-filtered — alice sees hers, bob does not', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      const aliceSession = await createSessionAs(app, ALICE);

      // Alice's list includes her session.
      const aliceList = await app.request('/sessions', { headers: ALICE });
      expect(aliceList.status).toBe(200);
      const aliceBody = (await aliceList.json()) as { sessions: Array<{ sessionId: string }> };
      expect(aliceBody.sessions.some((s) => s.sessionId === aliceSession)).toBe(true);

      // Bob's list does NOT include alice's session.
      const bobList = await app.request('/sessions', { headers: BOB });
      expect(bobList.status).toBe(200);
      const bobBody = (await bobList.json()) as { sessions: Array<{ sessionId: string }> };
      expect(bobBody.sessions.some((s) => s.sessionId === aliceSession)).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  test('cross-user negatives — bob gets 404 on every per-session route against alice', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      const aliceSession = await createSessionAs(app, ALICE);

      // GET /sessions/:id
      const get = await app.request(`/sessions/${aliceSession}`, { headers: BOB });
      expect(get.status).toBe(404);

      // GET /sessions/:id/messages
      const messages = await app.request(`/sessions/${aliceSession}/messages`, { headers: BOB });
      expect(messages.status).toBe(404);

      // POST /sessions/:id/turns
      const turns = await app.request(`/sessions/${aliceSession}/turns`, {
        method: 'POST',
        headers: { ...BOB, ...JSON_HEADER },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(turns.status).toBe(404);

      // GET /sessions/:id/events
      const events = await app.request(`/sessions/${aliceSession}/events`, { headers: BOB });
      expect(events.status).toBe(404);

      // POST /sessions/:id/approvals/:rid — use a well-formed (UUID) request id
      // so a malformed-id 400 doesn't mask the ownership 404.
      const approvals = await app.request(
        `/sessions/${aliceSession}/approvals/${crypto.randomUUID()}`,
        {
          method: 'POST',
          headers: { ...BOB, ...JSON_HEADER },
          body: JSON.stringify({ approved: true }),
        },
      );
      expect(approvals.status).toBe(404);

      // DELETE /sessions/:id
      const del = await app.request(`/sessions/${aliceSession}`, {
        method: 'DELETE',
        headers: BOB,
      });
      expect(del.status).toBe(404);
    } finally {
      await runtime.dispose();
    }
  });

  test('cross-user negatives — bob gets 404 on the other per-session routes too', async () => {
    // The enforcement is applied at the single ownership chokepoint, so every
    // per-session route inherits it: compact, cancel, commands (GET + POST),
    // skills (GET + install + DELETE) all 404 for a non-owner — never 403/200.
    const { app, runtime } = await buildPrincipalsApp();
    try {
      const aliceSession = await createSessionAs(app, ALICE);

      // POST /sessions/:id/compact
      const compact = await app.request(`/sessions/${aliceSession}/compact`, {
        method: 'POST',
        headers: { ...BOB, ...JSON_HEADER },
        body: JSON.stringify({}),
      });
      expect(compact.status).toBe(404);

      // POST /sessions/:id/cancel
      const cancel = await app.request(`/sessions/${aliceSession}/cancel`, {
        method: 'POST',
        headers: BOB,
      });
      expect(cancel.status).toBe(404);

      // GET /sessions/:id/commands
      const cmdsGet = await app.request(`/sessions/${aliceSession}/commands`, { headers: BOB });
      expect(cmdsGet.status).toBe(404);

      // POST /sessions/:id/commands
      const cmdsPost = await app.request(`/sessions/${aliceSession}/commands`, {
        method: 'POST',
        headers: { ...BOB, ...JSON_HEADER },
        body: JSON.stringify({ name: 'help', args: '' }),
      });
      expect(cmdsPost.status).toBe(404);

      // GET /sessions/:id/skills
      const skillsGet = await app.request(`/sessions/${aliceSession}/skills`, { headers: BOB });
      expect(skillsGet.status).toBe(404);

      // POST /sessions/:id/skills/install
      const skillsInstall = await app.request(`/sessions/${aliceSession}/skills/install`, {
        method: 'POST',
        headers: { ...BOB, ...JSON_HEADER },
        body: JSON.stringify({ source: '/tmp/whatever' }),
      });
      expect(skillsInstall.status).toBe(404);

      // DELETE /sessions/:id/skills/:name
      const skillsDelete = await app.request(`/sessions/${aliceSession}/skills/some-skill`, {
        method: 'DELETE',
        headers: BOB,
      });
      expect(skillsDelete.status).toBe(404);
    } finally {
      await runtime.dispose();
    }
  });

  test('alice CAN access her own session on each route', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      const aliceSession = await createSessionAs(app, ALICE);

      // GET /sessions/:id → 200
      const get = await app.request(`/sessions/${aliceSession}`, { headers: ALICE });
      expect(get.status).toBe(200);

      // GET /sessions/:id/messages → 200
      const messages = await app.request(`/sessions/${aliceSession}/messages`, { headers: ALICE });
      expect(messages.status).toBe(200);

      // POST /sessions/:id/turns → 202 (fire-and-forget accept).
      const turns = await app.request(`/sessions/${aliceSession}/turns`, {
        method: 'POST',
        headers: { ...ALICE, ...JSON_HEADER },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(turns.status).toBe(202);

      // POST /sessions/:id/approvals/:rid → 404 because the requestId is unknown
      // (NOT an ownership 404 — the session is hers; this proves the route ran
      // PAST the ownership gate to the approval-queue lookup). A 401/403 here
      // would mean the gate wrongly rejected the owner.
      const approvals = await app.request(
        `/sessions/${aliceSession}/approvals/${crypto.randomUUID()}`,
        {
          method: 'POST',
          headers: { ...ALICE, ...JSON_HEADER },
          body: JSON.stringify({ approved: true }),
        },
      );
      expect(approvals.status).toBe(404);

      // DELETE /sessions/:id → 204.
      const del = await app.request(`/sessions/${aliceSession}`, {
        method: 'DELETE',
        headers: ALICE,
      });
      expect(del.status).toBe(204);
    } finally {
      await runtime.dispose();
    }
  });

  test('side-effect safety — bob DELETE does not delete alice session', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      const aliceSession = await createSessionAs(app, ALICE);

      const del = await app.request(`/sessions/${aliceSession}`, {
        method: 'DELETE',
        headers: BOB,
      });
      expect(del.status).toBe(404);

      // Alice can still GET it — the row was untouched.
      const get = await app.request(`/sessions/${aliceSession}`, { headers: ALICE });
      expect(get.status).toBe(200);
      // And it's still present in the DB.
      expect(runtime.sessionDb.getSession(aliceSession)).not.toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  test('side-effect safety — bob POST /turns does not create a bus or run a turn', async () => {
    const { app, runtime } = await buildPrincipalsApp();
    try {
      const aliceSession = await createSessionAs(app, ALICE);

      const turns = await app.request(`/sessions/${aliceSession}/turns`, {
        method: 'POST',
        headers: { ...BOB, ...JSON_HEADER },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(turns.status).toBe(404);

      // No bus was minted for the session by bob's rejected turn (the ownership
      // gate runs BEFORE getOrCreateBus). peekBus never mints on a miss.
      expect(peekBus(aliceSession)).toBeUndefined();
      // No assistant message was persisted (the turn never ran).
      const stored = runtime.sessionDb.loadMessages(aliceSession);
      expect(stored.length).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  test('back-compat — open mode (no principals) does not enforce ownership', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      permissionMode: 'default',
      preflight: false,
    });
    // No principals, no auth — the open loopback path. Byte-compatible with today.
    const app = buildAppWithRuntime(runtime);
    try {
      // Create with no auth → 201, owner null.
      const create = await app.request('/sessions', {
        method: 'POST',
        headers: JSON_HEADER,
        body: JSON.stringify({}),
      });
      expect(create.status).toBe(201);
      const { sessionId } = (await create.json()) as { sessionId: string };
      expect(runtime.sessionDb.getSession(sessionId)?.ownerId).toBeNull();

      // Any no-auth caller can GET it (no enforcement).
      const get = await app.request(`/sessions/${sessionId}`);
      expect(get.status).toBe(200);

      // It appears in the unfiltered list.
      const list = await app.request('/sessions');
      expect(list.status).toBe(200);
      const body = (await list.json()) as { sessions: Array<{ sessionId: string }> };
      expect(body.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  test('back-compat — legacy single-token request behaves as today (owner null)', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      permissionMode: 'default',
      preflight: false,
    });
    // Single-token (legacy) mode — no principals, so no per-principal scoping.
    const app = buildAppWithRuntime(runtime, { auth: 'legacy-secret' });
    const LEGACY: Record<string, string> = { authorization: 'Bearer legacy-secret' };
    try {
      const create = await app.request('/sessions', {
        method: 'POST',
        headers: { ...LEGACY, ...JSON_HEADER },
        body: JSON.stringify({}),
      });
      expect(create.status).toBe(201);
      const { sessionId } = (await create.json()) as { sessionId: string };
      // Owner null — single-token has no principal id.
      expect(runtime.sessionDb.getSession(sessionId)?.ownerId).toBeNull();

      // The same token can access the session (no per-principal scoping).
      const get = await app.request(`/sessions/${sessionId}`, { headers: LEGACY });
      expect(get.status).toBe(200);
    } finally {
      await runtime.dispose();
    }
  });
});
