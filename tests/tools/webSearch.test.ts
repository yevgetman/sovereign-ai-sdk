import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Settings } from '@yevgetman/sov-sdk/config/schema';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { WebSearchTool } from '@yevgetman/sov-sdk/tools/WebSearchTool';

// Task 2.3 — WebSearchTool no longer reads `~/.harness/config.json` ambiently.
// Its provider config arrives on the ToolContext (`ctx.webSearch`), threaded
// from the resolved Settings by the runtime/CLI assembler. These tests feed the
// config via `ctx.webSearch` and exercise the env-var fallback directly.

const ctxBase: Partial<ToolContext> = {
  cwd: '/tmp',
  bundleRoot: '/tmp/bundle',
  sessionId: 'test',
  harnessHome: '/tmp/harness',
};

/** Build a ToolContext carrying the WebSearch config slice + a fetch mock. */
function ctxWith(webSearch: Settings['webSearch'], fetchImpl?: typeof fetch): ToolContext {
  return {
    ...ctxBase,
    ...(webSearch !== undefined ? { webSearch } : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  } as ToolContext;
}

function makeJsonFetchMock(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('WebSearchTool', () => {
  const prevTavily = process.env.TAVILY_API_KEY;
  const prevBrave = process.env.BRAVE_SEARCH_API_KEY;

  beforeEach(() => {
    Reflect.deleteProperty(process.env, 'TAVILY_API_KEY');
    Reflect.deleteProperty(process.env, 'BRAVE_SEARCH_API_KEY');
  });

  afterEach(() => {
    if (prevTavily === undefined) Reflect.deleteProperty(process.env, 'TAVILY_API_KEY');
    else process.env.TAVILY_API_KEY = prevTavily;
    if (prevBrave === undefined) Reflect.deleteProperty(process.env, 'BRAVE_SEARCH_API_KEY');
    else process.env.BRAVE_SEARCH_API_KEY = prevBrave;
  });

  test('isEnabled returns false when ctx carries no webSearch config and no env key', () => {
    expect(WebSearchTool.isEnabled(ctxBase as ToolContext)).toBe(false);
    // No ctx at all (e.g. a direct visibility probe) is also false with no env.
    expect(WebSearchTool.isEnabled()).toBe(false);
  });

  test('isEnabled returns true once a key is on ctx.webSearch', () => {
    expect(WebSearchTool.isEnabled(ctxWith({ apiKey: 'tvly-test' }))).toBe(true);
  });

  test('isEnabled honors the env-var fallback (no ctx key needed)', () => {
    process.env.TAVILY_API_KEY = 'tvly-env';
    expect(WebSearchTool.isEnabled(ctxBase as ToolContext)).toBe(true);
  });

  test('throws a helpful error when called with no API key (defense in depth)', async () => {
    await expect(WebSearchTool.call({ query: 'anything' }, ctxBase as ToolContext)).rejects.toThrow(
      /needs an API key/i,
    );
  });

  test('reads its provider config from ctx.webSearch — Tavily by default', async () => {
    const fetchImpl = makeJsonFetchMock({
      results: [
        { title: 'A', url: 'https://a.example', content: 'snippet A' },
        { title: 'B', url: 'https://b.example', content: 'snippet B' },
      ],
    });
    const result = await WebSearchTool.call(
      { query: 'foo bar' },
      ctxWith({ apiKey: 'tvly-test' }, fetchImpl),
    );
    expect(result.data.provider).toBe('tavily');
    expect(result.data.results).toHaveLength(2);
    expect(result.data.results[0]?.url).toBe('https://a.example');
    expect(result.data.results[0]?.snippet).toBe('snippet A');
  });

  test('uses Brave when ctx.webSearch.provider is brave', async () => {
    const fetchImpl = makeJsonFetchMock({
      web: { results: [{ title: 'X', url: 'https://x.example', description: 'about X' }] },
    });
    const result = await WebSearchTool.call(
      { query: 'topic' },
      ctxWith({ provider: 'brave', apiKey: 'brave-test' }, fetchImpl),
    );
    expect(result.data.provider).toBe('brave');
    expect(result.data.results[0]?.title).toBe('X');
    expect(result.data.results[0]?.snippet).toBe('about X');
  });

  test('falls back to env vars when the ctx-side key is missing', async () => {
    process.env.TAVILY_API_KEY = 'tvly-env';
    const fetchImpl = makeJsonFetchMock({ results: [] });
    const result = await WebSearchTool.call({ query: 'q' }, ctxWith(undefined, fetchImpl));
    expect(result.data.provider).toBe('tavily');
    expect(result.data.results).toEqual([]);
  });

  test('infers Tavily from a tvly- prefix when provider is unset', async () => {
    const fetchImpl = makeJsonFetchMock({
      results: [{ title: 'A', url: 'https://a.example', content: 'hi' }],
    });
    const result = await WebSearchTool.call(
      { query: 'q' },
      ctxWith({ apiKey: 'tvly-detected' }, fetchImpl),
    );
    expect(result.data.provider).toBe('tavily');
  });

  test('infers Brave from a non-tvly key when provider is unset', async () => {
    const fetchImpl = makeJsonFetchMock({
      web: { results: [{ title: 'X', url: 'https://x.example', description: 'about X' }] },
    });
    const result = await WebSearchTool.call(
      { query: 'q' },
      ctxWith({ apiKey: 'BSA-some-brave-key' }, fetchImpl),
    );
    expect(result.data.provider).toBe('brave');
  });

  test('explicit provider wins over the env-var that does not match', async () => {
    process.env.TAVILY_API_KEY = 'tvly-should-be-ignored';
    process.env.BRAVE_SEARCH_API_KEY = 'brave-from-env';
    const fetchImpl = makeJsonFetchMock({
      web: { results: [{ title: 'X', url: 'https://x.example', description: 'X' }] },
    });
    const result = await WebSearchTool.call(
      { query: 'q' },
      ctxWith({ provider: 'brave' }, fetchImpl),
    );
    expect(result.data.provider).toBe('brave');
  });

  test('picks Brave from env when no Tavily env is set and provider is unset', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'brave-env-only';
    const fetchImpl = makeJsonFetchMock({ web: { results: [] } });
    const result = await WebSearchTool.call({ query: 'q' }, ctxWith(undefined, fetchImpl));
    expect(result.data.provider).toBe('brave');
  });

  test('respects max_results input cap', async () => {
    const fetchImpl = makeJsonFetchMock({
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `r${i}`,
        url: `https://r${i}.example`,
        content: `s${i}`,
      })),
    });
    const result = await WebSearchTool.call(
      { query: 'q', max_results: 3 },
      ctxWith({ apiKey: 'tvly-k' }, fetchImpl),
    );
    expect(result.data.results).toHaveLength(3);
  });
});
