// WebSearchTool — query the open web through a configurable search
// provider (Tavily by default, Brave optional). Returns a small list of
// {title, url, snippet} results that the model can then drill into via
// WebFetch.
//
// Provider config (all optional, taken from `~/.harness/config.json`):
//   webSearch.provider: 'tavily' | 'brave'  — default 'tavily'
//   webSearch.apiKey:   string              — provider API key
//   webSearch.maxResults: int               — default cap (1–20)
//
// Falls back to env vars TAVILY_API_KEY / BRAVE_SEARCH_API_KEY when the
// config-side key is unset. With no key configured at all, the tool
// returns a structured error pointing the user to docs/usage.md.

import { z } from 'zod';
import { readConfig } from '../config/store.js';
import { buildTool } from '../tool/buildTool.js';

const DEFAULT_MAX_RESULTS = 5;
const ABSOLUTE_MAX_RESULTS = 20;
const TIMEOUT_MS = 10_000;

const inputSchema = z.object({
  query: z.string().min(1).describe('Search query string.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(ABSOLUTE_MAX_RESULTS)
    .optional()
    .describe(
      `Number of results to return (default ${DEFAULT_MAX_RESULTS}, max ${ABSOLUTE_MAX_RESULTS}).`,
    ),
});

type Input = z.infer<typeof inputSchema>;

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type Output = {
  query: string;
  provider: string;
  results: WebSearchResult[];
};

type WebSearchSettings = {
  provider?: string;
  apiKey?: string;
  maxResults?: number;
};

function resolveProviderSettings(env: NodeJS.ProcessEnv = process.env): {
  provider: 'tavily' | 'brave';
  apiKey: string | undefined;
  configuredMax: number | undefined;
} {
  const settings = (readConfig() as { webSearch?: WebSearchSettings }).webSearch ?? {};
  const provider = settings.provider === 'brave' ? 'brave' : 'tavily';
  const envKey = provider === 'brave' ? env.BRAVE_SEARCH_API_KEY : env.TAVILY_API_KEY;
  const apiKey = settings.apiKey ?? envKey;
  return { provider, apiKey, configuredMax: settings.maxResults };
}

async function searchTavily(
  query: string,
  apiKey: string,
  maxResults: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const response = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      include_answer: false,
      max_results: maxResults,
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as { results?: Array<Record<string, unknown>> };
  return (json.results ?? [])
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: typeof r.url === 'string' ? r.url : '',
      snippet: typeof r.content === 'string' ? r.content : '',
    }))
    .filter((r) => r.url.length > 0)
    .slice(0, maxResults);
}

async function searchBrave(
  query: string,
  apiKey: string,
  maxResults: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  const response = await fetchImpl(url.toString(), {
    headers: {
      accept: 'application/json',
      'x-subscription-token': apiKey,
    },
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brave ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as {
    web?: { results?: Array<Record<string, unknown>> };
  };
  return (json.web?.results ?? [])
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: typeof r.url === 'string' ? r.url : '',
      snippet: typeof r.description === 'string' ? r.description : '',
    }))
    .filter((r) => r.url.length > 0)
    .slice(0, maxResults);
}

export const WebSearchTool = buildTool<Input, Output>({
  name: 'WebSearch',
  description: () =>
    'Search the open web for relevant pages. Returns a small list of results with title, URL, and snippet. Use this to discover URLs to fetch in detail with WebFetch.',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    const env = (ctx as { env?: NodeJS.ProcessEnv }).env ?? process.env;
    const fetchImpl = (ctx as { fetchImpl?: typeof fetch }).fetchImpl ?? globalThis.fetch;
    const { provider, apiKey, configuredMax } = resolveProviderSettings(env);
    if (!apiKey) {
      throw new Error(
        `WebSearch needs an API key. Run \`sovereign config set webSearch.provider ${provider}\` and \`sovereign config set webSearch.apiKey <key>\`, or export ${
          provider === 'brave' ? 'BRAVE_SEARCH_API_KEY' : 'TAVILY_API_KEY'
        }. See docs/usage.md § Web Tools.`,
      );
    }
    const maxResults = Math.min(
      ABSOLUTE_MAX_RESULTS,
      input.max_results ?? configuredMax ?? DEFAULT_MAX_RESULTS,
    );
    const controller = new AbortController();
    const signalSource = (ctx as { signal?: AbortSignal }).signal;
    if (signalSource) signalSource.addEventListener('abort', () => controller.abort());
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const results =
        provider === 'brave'
          ? await searchBrave(input.query, apiKey, maxResults, fetchImpl, controller.signal)
          : await searchTavily(input.query, apiKey, maxResults, fetchImpl, controller.signal);
      return { data: { query: input.query, provider, results } };
    } finally {
      clearTimeout(timer);
    }
  },
  renderResult: (out) => ({
    content: [
      `WebSearch (${out.provider}) — ${out.results.length} result${out.results.length === 1 ? '' : 's'} for "${out.query}"`,
      ...out.results.map((r, i) => `\n${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`),
    ].join('\n'),
  }),
});

// Internal export for tests.
export const __test__ = { resolveProviderSettings };
