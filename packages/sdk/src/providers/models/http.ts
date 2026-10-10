import type { ModelFetch } from './types.js';

export function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const MAX_MODEL_BYTES = 16 * 1024 * 1024;
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_MODEL_BYTES)
    throw new Error('Model response exceeds byte bound');
  if (!response.body) throw new Error('Empty model response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('Model response aborted');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('Model response aborted');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MODEL_BYTES) {
        await reader.cancel();
        throw new Error('Model response exceeds byte bound');
      }
      chunks.push(value);
    }
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(output));
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
/** Bounded pages, same-origin links only, no credential-bearing off-origin redirects. */
export async function fetchModelPages(
  initialUrl: string,
  options: {
    fetch: ModelFetch;
    signal: AbortSignal;
    headers?: Record<string, string>;
  },
): Promise<unknown[]> {
  let url = initialUrl;
  const origin = new URL(url).origin;
  const rows: unknown[] = [];
  const visited = new Set<string>();
  for (let page = 0; page < 50; page++) {
    if (visited.has(url)) throw new Error('Model pagination cycle');
    visited.add(url);
    const response = await options.fetch(url, {
      signal: options.signal,
      ...(options.headers ? { headers: options.headers } : {}),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`);
    const body = object(await boundedJson(response, options.signal));
    const data = body.data ?? body.models;
    if (!Array.isArray(data)) throw new Error('Invalid model catalog data');
    if (rows.length + data.length > 50_000) throw new Error('Model catalog exceeds bound');
    rows.push(...data);
    const next = body.next ?? body.next_page;
    if (typeof next !== 'string' || !next) {
      if (body.has_more === true) {
        const last = body.last_id ?? object(data.at(-1)).id;
        if (typeof last !== 'string') throw new Error('Missing pagination cursor');
        const nextUrl = new URL(url);
        nextUrl.searchParams.set('after_id', last);
        url = nextUrl.toString();
        continue;
      }
      return rows;
    }
    const target = new URL(next, url);
    if (target.origin !== origin) throw new Error('Cross-origin model pagination refused');
    url = target.toString();
  }
  throw new Error('Model pagination exceeds bound');
}
