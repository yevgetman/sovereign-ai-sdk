// Unit tests for the redirect-safe fetch helper. Uses a recording fake
// fetch (no network) to prove the cross-origin header-stripping logic
// directly; the end-to-end secret-leak proof against real listeners lives
// in remoteClient.test.ts.

import { describe, expect, test } from 'bun:test';
import { buildSafeFetch } from '../../src/mcp/safeFetch.js';

type Hop = { url: string; headers: Record<string, string> };

/** A fake fetch that returns a scripted sequence of responses and records
 *  the URL + headers seen on each call. `script[i]` is the response for the
 *  i-th request; a `{ location }` entry yields a 307 redirect. */
function recordingFetch(script: Array<{ location?: string; status?: number }>) {
  const hops: Hop[] = [];
  let i = 0;
  const impl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    hops.push({ url: url.toString(), headers });
    const step = script[i] ?? {};
    i += 1;
    if (step.location) {
      return new Response(null, {
        status: step.status ?? 307,
        headers: { location: step.location },
      });
    }
    return new Response('ok', { status: step.status ?? 200 });
  };
  return { impl, hops };
}

describe('buildSafeFetch', () => {
  test('keeps auth headers on a same-origin redirect', async () => {
    const { impl, hops } = recordingFetch([{ location: 'https://mcp.example.com/v2' }, {}]);
    const safe = buildSafeFetch('https://mcp.example.com/v1', ['x-tenant'], impl);
    await safe('https://mcp.example.com/v1', {
      headers: { Authorization: 'Bearer t', 'X-API-Key': 'k', 'X-Tenant': 'acme' },
    });

    expect(hops).toHaveLength(2);
    // The follow-up to the same origin still carries every header.
    expect(hops[1]?.headers.authorization).toBe('Bearer t');
    expect(hops[1]?.headers['x-api-key']).toBe('k');
    expect(hops[1]?.headers['x-tenant']).toBe('acme');
  });

  test('strips ALL attached auth headers on a cross-origin redirect', async () => {
    const { impl, hops } = recordingFetch([
      { location: 'https://attacker.example.net/collect' },
      {},
    ]);
    const safe = buildSafeFetch('https://mcp.example.com/v1', ['x-tenant'], impl);
    await safe('https://mcp.example.com/v1', {
      headers: { Authorization: 'Bearer t', 'X-API-Key': 'k', 'X-Tenant': 'acme' },
    });

    expect(hops).toHaveLength(2);
    // The attacker origin receives NONE of the auth-bearing headers.
    expect(hops[1]?.headers.authorization).toBeUndefined();
    expect(hops[1]?.headers['x-api-key']).toBeUndefined();
    expect(hops[1]?.headers['x-tenant']).toBeUndefined();
  });

  test('treats a different port on the same host as cross-origin', async () => {
    const { impl, hops } = recordingFetch([{ location: 'https://mcp.example.com:9443/x' }, {}]);
    const safe = buildSafeFetch('https://mcp.example.com/v1', [], impl);
    await safe('https://mcp.example.com/v1', { headers: { 'X-API-Key': 'k' } });
    expect(hops[1]?.headers['x-api-key']).toBeUndefined();
  });

  test('does not re-add headers if a later hop returns same-origin', async () => {
    // origin → attacker (strip) → back to origin: headers stay stripped
    // because we never re-attach what we removed.
    const { impl, hops } = recordingFetch([
      { location: 'https://attacker.example.net/a' },
      { location: 'https://mcp.example.com/b' },
      {},
    ]);
    const safe = buildSafeFetch('https://mcp.example.com/v1', [], impl);
    await safe('https://mcp.example.com/v1', { headers: { Authorization: 'Bearer t' } });
    expect(hops[2]?.headers.authorization).toBeUndefined();
  });

  test('throws on exceeding the redirect cap', async () => {
    const { impl } = recordingFetch([
      { location: 'https://mcp.example.com/1' },
      { location: 'https://mcp.example.com/2' },
      { location: 'https://mcp.example.com/3' },
      { location: 'https://mcp.example.com/4' },
      { location: 'https://mcp.example.com/5' },
      { location: 'https://mcp.example.com/6' },
    ]);
    const safe = buildSafeFetch('https://mcp.example.com/v1', [], impl);
    await expect(
      safe('https://mcp.example.com/v1', { headers: { Authorization: 'Bearer t' } }),
    ).rejects.toThrow(/too many redirects/);
  });

  test('uses redirect:manual so the platform never auto-follows', async () => {
    let seenRedirect: string | undefined;
    const safe = buildSafeFetch('https://mcp.example.com/v1', [], async (_url, init) => {
      seenRedirect = init?.redirect;
      return new Response('ok', { status: 200 });
    });
    await safe('https://mcp.example.com/v1', {});
    expect(seenRedirect).toBe('manual');
  });
});
