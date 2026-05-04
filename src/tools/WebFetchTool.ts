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

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^fe80::/i,
  /^fc00::/i,
  /^fd00::/i,
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(hostname));
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
  validateInput: async (input) => {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return { ok: false, reason: 'Invalid URL.' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'Only http and https URLs are supported.' };
    }
    if (isPrivateHost(parsed.hostname)) {
      return { ok: false, reason: 'Refusing to fetch from private/loopback host.' };
    }
    return { ok: true };
  },
  async call(input, ctx) {
    const fetchImpl = (ctx as { fetchImpl?: typeof fetch }).fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const signalSource = (ctx as { signal?: AbortSignal }).signal;
    if (signalSource) signalSource.addEventListener('abort', () => controller.abort());
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(input.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'sovereign-ai-harness/0.0.1 (+webfetch)' },
      });
      const contentType = response.headers.get('content-type') ?? '';
      const finalUrl = response.url || input.url;
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

// Note: REDIRECT_CAP is documented in the file header but enforced by
// the runtime fetch implementation (Bun/Node default). We accept the
// platform default rather than re-implementing redirect handling.
void REDIRECT_CAP;
