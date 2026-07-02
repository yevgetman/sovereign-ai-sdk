// WebFetchTool — fetch a URL and return decoded text. Model-callable
// counterpart to the user-only `@url:` context reference. Strips HTML
// boilerplate (<script>, <style>, tags, common entities) so the model
// gets readable text instead of raw markup.
//
// Caps: 10s per-request timeout, 5 redirects, 1MB response body, 50K
// chars returned to the model by default. Refuses non-http(s) schemes
// and a small block-list of sensitive hosts (localhost, private IPs).

import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import { type LookupImpl, checkUrlAllowed, resolvePinnedTarget } from './ssrfGuard.js';

const DEFAULT_MAX_CHARS = 50_000;
const ABSOLUTE_MAX_CHARS = 200_000;
const RESPONSE_BYTE_CAP = 1_048_576; // 1 MB
const TIMEOUT_MS = 10_000;
const REDIRECT_CAP = 5;

const inputSchema = z.object({
  url: z.string().describe('Absolute http(s) URL to fetch.'),
  max_chars: z
    .number()
    .int()
    .positive()
    .max(ABSOLUTE_MAX_CHARS)
    .optional()
    .describe(`Cap on returned text length (default ${DEFAULT_MAX_CHARS}).`),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  truncated: boolean;
  text: string;
};

type Blocked = { data: Output; observation: { status: 'error'; summary: string } };

function blockedResult(url: string, finalUrl: string, reason: string): Blocked {
  return {
    data: { url, finalUrl, status: 0, contentType: '', truncated: false, text: reason },
    observation: { status: 'error', summary: reason },
  };
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ');
}

/**
 * Reduce raw HTML to readable text. Removes <script>, <style>, <noscript>
 * blocks, converts block-level tags into newlines, strips remaining tags,
 * decodes common HTML entities, and collapses runs of whitespace. Crude
 * but does the right thing for most documentation, blog posts, and news
 * articles. Won't extract JS-rendered SPA content (use a headless-browser
 * MCP server for that — Phase 12+).
 */
export function htmlToText(html: string): string {
  let out = html;
  out = out.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  out = out.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  out = out.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(
    /<\/?(p|br|div|h[1-6]|li|tr|hr|article|section|header|footer|main|nav)\b[^>]*>/gi,
    '\n',
  );
  out = out.replace(/<[^>]+>/g, '');
  out = decodeBasicEntities(out);
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return out;
}

async function readBoundedText(response: Response, byteCap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > byteCap) {
      chunks.push(value.slice(0, byteCap - total));
      total = byteCap;
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const concatenated = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    concatenated.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(concatenated);
}

export const WebFetchTool = buildTool<Input, Output>({
  name: 'WebFetch',
  description: () =>
    'Fetch a URL and return its content as readable text. HTML is stripped of script/style/markup; non-text content types are not supported. Use for documentation pages, blog posts, news articles, raw markdown/JSON, etc.',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderHint: { kind: 'markdown' },
  validateInput: async (input) => {
    const guard = checkUrlAllowed(input.url);
    return guard.ok ? { ok: true } : { ok: false, reason: guard.reason };
  },
  async call(input, ctx) {
    const fetchImpl = (ctx as { fetchImpl?: typeof fetch }).fetchImpl ?? globalThis.fetch;
    const lookupImpl = (ctx as { lookupImpl?: LookupImpl }).lookupImpl;
    // The resolve-validate-pin DNS-rebinding guard ALWAYS runs, independent of
    // whether fetchImpl is injected (finding F11): wrapping fetch (proxy/tracing/
    // retry) must never silently drop the guard. It uses the injected lookupImpl
    // when provided, else the default node:dns resolver — so hermetic tests
    // inject a lookupImpl rather than relying on an injected fetch to disable it.

    // Defense in depth: the dispatcher runs validateInput before call(), but
    // direct/programmatic callers must be guarded here too.
    const initialGuard = checkUrlAllowed(input.url);
    if (!initialGuard.ok) return blockedResult(input.url, input.url, initialGuard.reason);

    const controller = new AbortController();
    const signalSource = (ctx as { signal?: AbortSignal }).signal;
    if (signalSource) signalSource.addEventListener('abort', () => controller.abort());
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // Manual redirect handling so every hop's host is re-validated: a public
      // URL that 30x-redirects to a private/loopback/metadata address must not
      // be followed (SSRF). Also enforces the documented REDIRECT_CAP, which
      // the previous redirect:'follow' left to the platform default.
      let currentUrl = input.url;
      let response: Response;
      let redirects = 0;
      while (true) {
        // Resolve once, validate EVERY resolved address, and PIN the connection
        // to a validated IP (plain http: host→IP rewrite + Host header; https:
        // unrewritten with a documented residual). Bounds the lookup by the same
        // TIMEOUT_MS as the fetch so a slow resolver can't outlast the cap. Done
        // every hop alongside the sync scheme/literal gate (DNS-rebinding /
        // *.nip.io). The pinned IP closes the resolve→connect re-resolution gap.
        const pin = await resolvePinnedTarget(currentUrl, lookupImpl, TIMEOUT_MS);
        if (!pin.ok) return blockedResult(input.url, currentUrl, pin.reason);
        const connectUrl = pin.url;
        const pinnedHeaders = pin.headers ?? {};
        response = await fetchImpl(connectUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'user-agent': 'sovereign-ai-harness/0.0.1 (+webfetch)', ...pinnedHeaders },
        });
        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get('location');
        if (!isRedirect || !location) break;
        if (redirects >= REDIRECT_CAP) {
          return blockedResult(input.url, currentUrl, `too many redirects (> ${REDIRECT_CAP})`);
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          return blockedResult(input.url, currentUrl, 'invalid redirect Location header');
        }
        const hopGuard = checkUrlAllowed(nextUrl);
        if (!hopGuard.ok) {
          return blockedResult(input.url, currentUrl, `redirect blocked: ${hopGuard.reason}`);
        }
        currentUrl = nextUrl;
        redirects += 1;
      }
      const contentType = response.headers.get('content-type') ?? '';
      // Prefer the human-readable currentUrl: when we pin plain-http to an IP,
      // response.url reports the IP form, which would be misleading.
      const finalUrl = currentUrl || response.url;
      const status = response.status;
      const raw = await readBoundedText(response, RESPONSE_BYTE_CAP);
      const isHtml = /text\/html|application\/xhtml/i.test(contentType);
      const decoded = isHtml ? htmlToText(raw) : raw;
      const cap = input.max_chars ?? DEFAULT_MAX_CHARS;
      const truncated = decoded.length > cap;
      const text = truncated ? `${decoded.slice(0, cap)}\n[... truncated]` : decoded;
      const body =
        !response.ok && decoded.length === 0 ? `HTTP ${status} ${response.statusText}` : text;
      const ok = response.ok;
      const next_actions: string[] = [];
      if (!ok) {
        if (status === 404) {
          next_actions.push(
            'try the Web Archive (https://web.archive.org/web/*/<url>) for cached copies',
          );
        } else if (status === 403 || status === 401) {
          next_actions.push(
            'the page requires auth — paste content in directly if you have access',
          );
        } else if (status === 429) {
          next_actions.push('rate-limited — wait and retry, or fetch a different URL');
        } else if (status >= 500) {
          next_actions.push('server error — retry once, or fetch a different mirror/CDN');
        }
      }
      if (truncated) {
        next_actions.push(`raise max_chars (current cap ${cap}) or fetch a more specific URL`);
      }
      return {
        data: { url: input.url, finalUrl, status, contentType, truncated, text: body },
        observation: {
          status: ok ? 'success' : 'error',
          summary: ok
            ? `${status} ${contentType.split(';')[0] || 'unknown'}, ${text.length} chars${truncated ? ' (truncated)' : ''}`
            : `HTTP ${status} ${response.statusText}`,
          ...(next_actions.length > 0 ? { next_actions } : {}),
          artifacts: [finalUrl],
        },
      };
    } finally {
      clearTimeout(timer);
    }
  },
  renderResult: (out) => ({
    content: [
      `URL: ${out.finalUrl}`,
      `Status: ${out.status}`,
      `Content-Type: ${out.contentType}`,
      `Length: ${out.text.length} chars${out.truncated ? ' (truncated)' : ''}`,
      '',
      out.text,
    ].join('\n'),
  }),
});
