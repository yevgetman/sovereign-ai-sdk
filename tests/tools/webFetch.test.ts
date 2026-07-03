import { describe, expect, test } from 'bun:test';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { WebFetchTool, htmlToText } from '@yevgetman/sov-sdk/tools/WebFetchTool';
import type { LookupImpl } from '@yevgetman/sov-sdk/tools/ssrfGuard';

const ctxBase: Partial<ToolContext> = {
  cwd: '/tmp',
  bundleRoot: '/tmp/bundle',
  sessionId: 'test',
  harnessHome: '/tmp/harness',
};

function makeFetchMock(init: {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}): typeof fetch {
  return (async (_url: string | URL | Request) => {
    const headers = new Headers(init.headers ?? { 'content-type': 'text/plain' });
    return new Response(init.body, {
      status: init.status ?? 200,
      headers,
    }) as Response & { url: string };
  }) as unknown as typeof fetch;
}

// The resolve-validate-pin DNS guard always runs now (finding F11), so
// hostname-based call() tests inject a lookupImpl resolving to a public IP to
// stay hermetic instead of depending on real DNS.
const publicLookup: LookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];

describe('htmlToText', () => {
  test('strips script and style blocks entirely', () => {
    const html = `
      <html><head><style>body{color:red}</style></head>
      <body><script>alert(1)</script><h1>Title</h1><p>body</p></body></html>
    `;
    const text = htmlToText(html);
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('color:red');
    expect(text).toContain('Title');
    expect(text).toContain('body');
  });

  test('decodes basic HTML entities', () => {
    expect(htmlToText('A &amp; B &lt;tag&gt; &quot;ok&quot;')).toBe('A & B <tag> "ok"');
    expect(htmlToText('&#65;&#x42;')).toBe('AB');
    expect(htmlToText('a&nbsp;b')).toBe('a b');
  });

  test('inserts newlines for block-level tags', () => {
    const text = htmlToText('<p>one</p><p>two</p><div>three</div>');
    expect(text.split('\n')).toEqual(['one', 'two', 'three']);
  });

  test('strips inline tags without losing the text content', () => {
    expect(htmlToText('<a href="x">click</a> me')).toBe('click me');
    expect(htmlToText('<strong>bold</strong> normal')).toBe('bold normal');
  });

  test('removes HTML comments', () => {
    expect(htmlToText('before <!-- secret --> after')).toBe('before after');
  });
});

describe('WebFetchTool.validateInput', () => {
  test('accepts http and https', async () => {
    const v1 = await WebFetchTool.validateInput?.(
      { url: 'https://example.com' },
      ctxBase as ToolContext,
    );
    expect(v1?.ok).toBe(true);
    const v2 = await WebFetchTool.validateInput?.(
      { url: 'http://example.com' },
      ctxBase as ToolContext,
    );
    expect(v2?.ok).toBe(true);
  });

  test('rejects non-http(s) schemes', async () => {
    const v = await WebFetchTool.validateInput?.(
      { url: 'ftp://example.com' },
      ctxBase as ToolContext,
    );
    expect(v?.ok).toBe(false);
  });

  test('rejects malformed URLs', async () => {
    const v = await WebFetchTool.validateInput?.({ url: 'not a url' }, ctxBase as ToolContext);
    expect(v?.ok).toBe(false);
  });

  test('refuses localhost and private IPs', async () => {
    for (const host of [
      'http://localhost/',
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
    ]) {
      const v = await WebFetchTool.validateInput?.({ url: host }, ctxBase as ToolContext);
      expect(v?.ok).toBe(false);
    }
  });
});

describe('WebFetchTool.call', () => {
  test('returns extracted text from an HTML response', async () => {
    const fetchImpl = makeFetchMock({
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>Heading</h1><p>Paragraph text.</p></body></html>',
    });
    const ctx = { ...ctxBase, fetchImpl, lookupImpl: publicLookup } as unknown as ToolContext;
    const result = await WebFetchTool.call({ url: 'https://example.com' }, ctx);
    expect(result.data.status).toBe(200);
    expect(result.data.text).toContain('Heading');
    expect(result.data.text).toContain('Paragraph text.');
    expect(result.data.text).not.toContain('<html>');
  });

  test('passes plaintext content through verbatim', async () => {
    const fetchImpl = makeFetchMock({
      headers: { 'content-type': 'text/plain' },
      body: '# Markdown\nlots of text\n',
    });
    const ctx = { ...ctxBase, fetchImpl, lookupImpl: publicLookup } as unknown as ToolContext;
    const result = await WebFetchTool.call({ url: 'https://example.com/raw.md' }, ctx);
    expect(result.data.text).toContain('# Markdown');
  });

  test('truncates output to max_chars and flags truncated', async () => {
    const fetchImpl = makeFetchMock({
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(10_000),
    });
    const ctx = { ...ctxBase, fetchImpl, lookupImpl: publicLookup } as unknown as ToolContext;
    const result = await WebFetchTool.call({ url: 'https://example.com', max_chars: 200 }, ctx);
    expect(result.data.truncated).toBe(true);
    expect(result.data.text.length).toBeLessThan(300); // 200 + truncation suffix
    expect(result.data.text).toContain('[... truncated]');
  });

  test('non-2xx responses return the body content if any, or the status text', async () => {
    const fetchImpl = makeFetchMock({
      status: 404,
      headers: { 'content-type': 'text/plain' },
      body: '',
    });
    const ctx = { ...ctxBase, fetchImpl, lookupImpl: publicLookup } as unknown as ToolContext;
    const result = await WebFetchTool.call({ url: 'https://example.com/missing' }, ctx);
    expect(result.data.status).toBe(404);
    expect(result.data.text).toContain('HTTP 404');
  });
});

// A fetch mock that records every URL it is asked to fetch and returns a
// scripted sequence of responses (one per call; the last repeats).
function makeSeqFetchMock(
  responses: Array<{ status?: number; headers?: Record<string, string>; body?: string }>,
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const r = responses[Math.min(i, responses.length - 1)] ?? { body: '' };
    i += 1;
    const headers = new Headers(r.headers ?? { 'content-type': 'text/plain' });
    return new Response(r.body ?? '', { status: r.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe('WebFetchTool SSRF hardening', () => {
  test('validateInput refuses link-local / metadata and 0.0.0.0', async () => {
    for (const host of ['http://169.254.169.254/latest/meta-data', 'http://0.0.0.0/']) {
      const v = await WebFetchTool.validateInput?.({ url: host }, ctxBase as ToolContext);
      expect(v?.ok).toBe(false);
    }
  });

  test('call() refuses a private initial URL without fetching it', async () => {
    const { fetchImpl, urls } = makeSeqFetchMock([{ body: 'should not be reached' }]);
    const ctx = { ...ctxBase, fetchImpl } as ToolContext;
    const result = await WebFetchTool.call({ url: 'http://169.254.169.254/' }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(urls).toHaveLength(0);
  });

  test('call() blocks a redirect into a private host and never fetches it', async () => {
    const { fetchImpl, urls } = makeSeqFetchMock([
      { status: 302, headers: { location: 'http://169.254.169.254/' } },
      { body: 'INTERNAL SECRET' },
    ]);
    const ctx = { ...ctxBase, fetchImpl, lookupImpl: publicLookup } as unknown as ToolContext;
    const result = await WebFetchTool.call({ url: 'https://example.com/start' }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(result.data.text).toContain('redirect blocked');
    expect(urls).toEqual(['https://example.com/start']);
  });

  test('call() follows a normal public→public redirect', async () => {
    const { fetchImpl, urls } = makeSeqFetchMock([
      { status: 302, headers: { location: 'https://example.org/final' } },
      { headers: { 'content-type': 'text/plain' }, body: 'final body' },
    ]);
    const ctx = { ...ctxBase, fetchImpl, lookupImpl: publicLookup } as unknown as ToolContext;
    const result = await WebFetchTool.call({ url: 'https://example.com/start' }, ctx);
    expect(result.data.status).toBe(200);
    expect(result.data.text).toContain('final body');
    expect(urls).toEqual(['https://example.com/start', 'https://example.org/final']);
  });
});

describe('WebFetchTool DNS resolve-validate-pin (findings #4/#5/#12)', () => {
  // With lookupImpl injected the DNS guard turns ON even under an injected
  // fetch double, exercising the resolve-all → block-if-any-private → pin path.

  test('finding #4: blocks a multi-IP host where ANY resolved address is private', async () => {
    const { fetchImpl, urls } = makeSeqFetchMock([{ body: 'INTERNAL' }]);
    const lookupImpl: LookupImpl = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 }, // one private among many
    ];
    const ctx = { ...ctxBase, fetchImpl, lookupImpl } as unknown as ToolContext;
    const result = await WebFetchTool.call({ url: 'http://multi.example/' }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(urls).toHaveLength(0); // never fetched
    expect(result.data.text).not.toContain('INTERNAL');
  });

  test('finding #4: plain-http pins to the validated IP + sends original Host', async () => {
    const seen: { url: string; host: string | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), host: headers.get('host') });
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;
    const lookupImpl: LookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
    const ctx = { ...ctxBase, fetchImpl, lookupImpl } as unknown as ToolContext;
    const result = await WebFetchTool.call({ url: 'http://pin.example/path' }, ctx);
    expect(result.data.status).toBe(200);
    expect(seen[0]?.url).toBe('http://93.184.216.34/path'); // pinned to the IP
    expect(seen[0]?.host).toBe('pin.example'); // original Host preserved
    expect(result.data.finalUrl).toBe('http://pin.example/path'); // human-readable
  });

  // Finding F11 — wrapping fetch (proxy/tracing/retry) must NOT silently disable
  // the DNS-rebinding guard. With fetchImpl injected but NO lookupImpl, the
  // resolve-validate-pin guard must still run and refuse before any fetch.
  // `.invalid` (RFC 6761) never resolves, so the default resolver fail-closes
  // hermetically with no network.
  test('finding F11: DNS guard runs even when fetchImpl is injected without a lookupImpl', async () => {
    const { fetchImpl, urls } = makeSeqFetchMock([{ body: 'SECRET' }]);
    const ctx = { ...ctxBase, fetchImpl } as ToolContext; // no lookupImpl injected
    const result = await WebFetchTool.call({ url: 'http://rebind.attacker.invalid/' }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(urls).toHaveLength(0); // guard fired before any fetch
    expect(result.data.text).not.toContain('SECRET');
  });

  test('finding #5: a DNS error fails CLOSED (refusal, no fetch)', async () => {
    const { fetchImpl, urls } = makeSeqFetchMock([{ body: 'INTERNAL' }]);
    const lookupImpl: LookupImpl = async () => {
      throw new Error('SERVFAIL');
    };
    const ctx = { ...ctxBase, fetchImpl, lookupImpl } as unknown as ToolContext;
    const result = await WebFetchTool.call({ url: 'http://servfail.example/' }, ctx);
    expect(result.observation?.status).toBe('error');
    expect(urls).toHaveLength(0);
    expect(result.data.text).not.toContain('INTERNAL');
  });
});
