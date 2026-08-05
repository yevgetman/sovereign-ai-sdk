import { describe, expect, test } from 'bun:test';
import { createRestAdapter } from './restAdapter.js';

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(init === undefined ? { url } : { url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('createRestAdapter', () => {
  test('reads the feed from the host-declared base url', async () => {
    const { impl, calls } = stubFetch(() => ok({ currentSessionId: 'x', events: [], details: [] }));

    const feed = await createRestAdapter({ baseUrl: '/api/debug', fetchImpl: impl }).getAgentFeed();

    expect(calls[0]?.url).toBe('/api/debug/feed');
    expect(feed.currentSessionId).toBe('x');
  });

  test('tolerates a trailing slash in the base url', async () => {
    const { impl, calls } = stubFetch(() =>
      ok({ currentSessionId: null, events: [], details: [] }),
    );

    await createRestAdapter({ baseUrl: '/api/debug/', fetchImpl: impl }).getAgentFeed();

    expect(calls[0]?.url).toBe('/api/debug/feed');
  });

  test('a REFUSAL yields an empty surface, not a crash', async () => {
    // A host that gates this route answers 403/404 to people who may not look.
    // Surfacing a stack trace to them helps nobody.
    const { impl } = stubFetch(() => new Response('', { status: 404 }));

    const feed = await createRestAdapter({ baseUrl: '/api/debug', fetchImpl: impl }).getAgentFeed();

    expect(feed).toEqual({ currentSessionId: null, events: [], details: [] });
  });

  test('opting a surface out REMOVES the method so the tab disappears', () => {
    const adapter = createRestAdapter({ baseUrl: '/api/debug', telemetry: false });

    // Not "returns []" — absent, because the element probes for the property.
    expect(adapter.getTelemetry).toBeUndefined();
    expect(typeof adapter.getData).toBe('function');
  });

  test('passes host headers through, including a per-request function', async () => {
    const { impl, calls } = stubFetch(() =>
      ok({ currentSessionId: null, events: [], details: [] }),
    );
    let token = 'first';

    const adapter = createRestAdapter({
      baseUrl: '/api/debug',
      headers: () => ({ authorization: `Bearer ${token}` }),
      fetchImpl: impl,
    });
    await adapter.getAgentFeed();
    token = 'rotated';
    await adapter.getAgentFeed();

    const headersOf = (index: number) =>
      (calls[index]?.init?.headers ?? {}) as Record<string, string>;
    expect(headersOf(0).authorization).toBe('Bearer first');
    expect(headersOf(1).authorization).toBe('Bearer rotated');
  });

  test('reportEvent never rejects into the host page', async () => {
    const { impl } = stubFetch(() => {
      throw new Error('network gone');
    });

    const adapter = createRestAdapter({ baseUrl: '/api/debug', fetchImpl: impl });

    expect(() => adapter.reportEvent?.({ name: 'nav', detail: '/jobs' })).not.toThrow();
  });
});
