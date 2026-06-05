// Phase A T4 — configurable CORS for the native HTTP+SSE protocol.
//
// A browser-based web UI (Phase C) on another origin needs CORS to call the
// gateway. Listed origins get their origin echoed in Access-Control-Allow-Origin
// (never `*`), plus GET/POST/OPTIONS and the Authorization/Content-Type/
// Last-Event-ID request headers; preflight OPTIONS short-circuits 204. Non-listed
// origins get no ACAO header. The no-corsOrigins default MUST be byte-unchanged.

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

async function withMockRuntime(
  label: string,
  fn: (runtime: Awaited<ReturnType<typeof buildRuntime>>) => Promise<void>,
): Promise<void> {
  const home = join(tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
  try {
    runtime = await buildRuntime({
      cwd: process.cwd(),
      provider: 'mock',
      harnessHome: home,
    });
    await fn(runtime);
  } finally {
    if (runtime !== null) await runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}

describe('native protocol CORS — buildAppWithRuntime({ corsOrigins })', () => {
  test('preflight OPTIONS from a listed origin echoes the origin + allows methods/headers', async () => {
    await withMockRuntime('t4-preflight', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { corsOrigins: ['https://app.example'] });
      const res = await app.request('/sessions', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, Content-Type, Last-Event-ID',
        },
      });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');

      const allowMethods = res.headers.get('Access-Control-Allow-Methods') ?? '';
      expect(allowMethods).toContain('GET');
      expect(allowMethods).toContain('POST');
      expect(allowMethods).toContain('OPTIONS');

      const allowHeaders = res.headers.get('Access-Control-Allow-Headers') ?? '';
      expect(allowHeaders).toContain('Authorization');
      expect(allowHeaders).toContain('Content-Type');
      expect(allowHeaders).toContain('Last-Event-ID');
    });
  });

  test('preflight OPTIONS short-circuits with 204 (not blocked by auth)', async () => {
    await withMockRuntime('t4-preflight-204', async (runtime) => {
      const app = buildAppWithRuntime(runtime, {
        auth: 'secret',
        corsOrigins: ['https://app.example'],
      });
      const res = await app.request('/sessions', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example',
          'Access-Control-Request-Method': 'POST',
        },
      });
      // CORS runs before auth → preflight is NOT 401; it short-circuits 204.
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
    });
  });

  test('a request from a non-listed origin gets NO Access-Control-Allow-Origin', async () => {
    await withMockRuntime('t4-evil', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { corsOrigins: ['https://app.example'] });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
      });
      // The evil origin must never be echoed back.
      expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  test('a real (non-OPTIONS) request from a listed origin gets the ACAO header', async () => {
    await withMockRuntime('t4-actual', async (runtime) => {
      const app = buildAppWithRuntime(runtime, { corsOrigins: ['https://app.example'] });
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { Origin: 'https://app.example' },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
    });
  });
});

describe('native protocol CORS — no corsOrigins is byte-unchanged', () => {
  test('no corsOrigins → no Access-Control-Allow-Origin header at all', async () => {
    await withMockRuntime('t4-default', async (runtime) => {
      const app = buildAppWithRuntime(runtime);
      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { Origin: 'https://app.example' },
      });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });
});
