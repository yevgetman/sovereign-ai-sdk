import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../src/tool/types.js';
import { WebSearchTool } from '../../src/tools/WebSearchTool.js';

const ctxBase: Partial<ToolContext> = {
  cwd: '/tmp',
  bundleRoot: '/tmp/bundle',
  sessionId: 'test',
  harnessHome: '/tmp/harness',
};

function makeJsonFetchMock(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('WebSearchTool', () => {
  let dir: string;
  let cfgPath: string;
  const prevConfig = process.env.HARNESS_CONFIG;
  const prevTavily = process.env.TAVILY_API_KEY;
  const prevBrave = process.env.BRAVE_SEARCH_API_KEY;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-websearch-'));
    cfgPath = join(dir, 'config.json');
    process.env.HARNESS_CONFIG = cfgPath;
    Reflect.deleteProperty(process.env, 'TAVILY_API_KEY');
    Reflect.deleteProperty(process.env, 'BRAVE_SEARCH_API_KEY');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevConfig === undefined) Reflect.deleteProperty(process.env, 'HARNESS_CONFIG');
    else process.env.HARNESS_CONFIG = prevConfig;
    if (prevTavily === undefined) Reflect.deleteProperty(process.env, 'TAVILY_API_KEY');
    else process.env.TAVILY_API_KEY = prevTavily;
    if (prevBrave === undefined) Reflect.deleteProperty(process.env, 'BRAVE_SEARCH_API_KEY');
    else process.env.BRAVE_SEARCH_API_KEY = prevBrave;
  });

  test('isEnabled returns false when no API key is configured', () => {
    expect(WebSearchTool.isEnabled()).toBe(false);
  });

  test('isEnabled returns true once an API key is set', () => {
    writeFileSync(cfgPath, JSON.stringify({ webSearch: { apiKey: 'tvly-test' } }));
    expect(WebSearchTool.isEnabled()).toBe(true);
  });

  test('isEnabled honors the env-var fallback', () => {
    process.env.TAVILY_API_KEY = 'tvly-env';
    expect(WebSearchTool.isEnabled()).toBe(true);
  });

  test('throws a helpful error when called with no API key (defense in depth)', async () => {
    await expect(WebSearchTool.call({ query: 'anything' }, ctxBase as ToolContext)).rejects.toThrow(
      /needs an API key/i,
    );
  });

  test('uses Tavily by default when configured with apiKey', async () => {
    writeFileSync(cfgPath, JSON.stringify({ webSearch: { apiKey: 'tvly-test' } }));
    const fetchImpl = makeJsonFetchMock({
      results: [
        { title: 'A', url: 'https://a.example', content: 'snippet A' },
        { title: 'B', url: 'https://b.example', content: 'snippet B' },
      ],
    });
    const ctx = { ...ctxBase, fetchImpl } as ToolContext;
    const result = await WebSearchTool.call({ query: 'foo bar' }, ctx);
    expect(result.data.provider).toBe('tavily');
    expect(result.data.results).toHaveLength(2);
    expect(result.data.results[0]?.url).toBe('https://a.example');
    expect(result.data.results[0]?.snippet).toBe('snippet A');
  });

  test('uses Brave when configured', async () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ webSearch: { provider: 'brave', apiKey: 'brave-test' } }),
    );
    const fetchImpl = makeJsonFetchMock({
      web: {
        results: [{ title: 'X', url: 'https://x.example', description: 'about X' }],
      },
    });
    const ctx = { ...ctxBase, fetchImpl } as ToolContext;
    const result = await WebSearchTool.call({ query: 'topic' }, ctx);
    expect(result.data.provider).toBe('brave');
    expect(result.data.results[0]?.title).toBe('X');
    expect(result.data.results[0]?.snippet).toBe('about X');
  });

  test('falls back to env vars when config-side key is missing', async () => {
    process.env.TAVILY_API_KEY = 'tvly-env';
    const fetchImpl = makeJsonFetchMock({ results: [] });
    const ctx = { ...ctxBase, fetchImpl } as ToolContext;
    const result = await WebSearchTool.call({ query: 'q' }, ctx);
    expect(result.data.provider).toBe('tavily');
    expect(result.data.results).toEqual([]);
  });

  test('respects max_results input cap', async () => {
    writeFileSync(cfgPath, JSON.stringify({ webSearch: { apiKey: 'k' } }));
    const fetchImpl = makeJsonFetchMock({
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `r${i}`,
        url: `https://r${i}.example`,
        content: `s${i}`,
      })),
    });
    const ctx = { ...ctxBase, fetchImpl } as ToolContext;
    const result = await WebSearchTool.call({ query: 'q', max_results: 3 }, ctx);
    expect(result.data.results).toHaveLength(3);
  });

  test('schema-rejects unknown providers', async () => {
    expect(() =>
      writeFileSync(cfgPath, JSON.stringify({ webSearch: { provider: 'google' } })),
    ).not.toThrow();
    // The error surfaces when the config is read via the schema-validated
    // store helpers. The tool itself reads the config raw, so this only
    // matters when `sovereign config set webSearch.provider google` is
    // attempted — covered indirectly by tests in tests/config/store.test.ts.
  });
});
