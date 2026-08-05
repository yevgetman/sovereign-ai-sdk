// The convenience adapter for the common case: a host that mounts the SDK's own
// debug route handlers.
//
// It carries NO credential of its own. `credentials: 'include'` sends whatever
// session the host already has — the SDK never invents an auth story, and a
// host with a token passes it through `headers`.

import type { AgentFeed, DataEvent, DebugConsoleAdapter, TelemetryEvent } from './types.js';

export interface RestAdapterOptions {
  /** Where the host mounted the handlers, e.g. `/api/debug`. */
  baseUrl: string;
  /** Extra headers per request — a bearer token, a CSRF header. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /**
   * Opt OUT of a surface even though the route exists. Absent means the tab is
   * offered; the SDK never probes by fetching.
   */
  telemetry?: boolean;
  data?: boolean;
  fetchImpl?: typeof fetch;
}

const EMPTY_FEED: AgentFeed = { currentSessionId: null, events: [], details: [] };

export function createRestAdapter(options: RestAdapterOptions): DebugConsoleAdapter {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/$/, '');

  const get = async <T>(path: string, fallback: T): Promise<T> => {
    const headers = typeof options.headers === 'function' ? options.headers() : options.headers;
    const response = await doFetch(`${base}${path}`, {
      credentials: 'include',
      headers: { accept: 'application/json', ...headers },
    });
    // A refusal is not a crash: a host that gates this route returns 403/404 to
    // people who may not look, and the console shows an empty surface rather
    // than an error the viewer can do nothing about.
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  };

  const adapter: DebugConsoleAdapter = {
    getAgentFeed: () => get<AgentFeed>('/feed', EMPTY_FEED),
    reportEvent: (event) => {
      const headers = typeof options.headers === 'function' ? options.headers() : options.headers;
      void doFetch(`${base}/event`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(event),
      }).catch(() => undefined); // fire-and-forget: never break a host's page
    },
  };

  // Assigned CONDITIONALLY — the element probes for the property, so opting a
  // surface out has to remove the method, not stub it with an empty array.
  if (options.telemetry !== false) {
    adapter.getTelemetry = () => get<TelemetryEvent[]>('/telemetry', []);
  }
  if (options.data !== false) {
    adapter.getData = () => get<DataEvent[]>('/data', []);
  }
  return adapter;
}
