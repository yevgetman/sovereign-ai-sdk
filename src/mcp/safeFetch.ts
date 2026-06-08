// Redirect-safe fetch for remote MCP transports.
//
// SECURITY: the SDK transports attach our resolved auth headers
// (`Authorization`, `X-API-Key`, and any operator-supplied custom headers)
// to every request. Bun/undici strips `Authorization` on a cross-origin
// redirect, but NOT `X-API-Key` or arbitrary custom headers — so a
// malicious or open-redirecting configured server could 30x-bounce a
// request to an attacker-controlled origin and harvest those secrets.
//
// `buildSafeFetch` does MANUAL redirect handling: it follows up to a small
// cap, and on EVERY hop whose target origin differs from the ORIGINAL
// configured server origin it strips the FULL set of auth-bearing headers
// we attached before issuing the next request. Same-origin redirects
// (including http→https on the same host:port) keep the headers.
//
// The threat here is secret-in-transit, not SSRF — the destination URL is
// operator config, so there is no host allow-list (cf. WebFetchTool, where
// the URL is model-controlled and every hop is re-validated).

/** Matches the SDK's `FetchLike` (shared/transport.js) and is structurally
 *  compatible with the `eventsource` package's `FetchLike` (the GET-stream
 *  override), so one implementation drives both transports. */
export type SafeFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Follow at most this many redirects before giving up. Mirrors
 *  `WebFetchTool`'s `REDIRECT_CAP`. */
const MAX_REDIRECTS = 5;

/** Header names whose values we attach as auth and therefore must never
 *  leak to a different origin. Compared case-insensitively. Operator custom
 *  `headers` are stripped too — they are passed in via `attachedHeaderNames`. */
const ALWAYS_SENSITIVE = ['authorization', 'x-api-key'] as const;

/** True when `target` resolves to a different origin than `original`.
 *  Same scheme + host + port ⇒ same origin (so http→https on the same
 *  host:port is treated as cross-origin only if the port actually differs —
 *  which it does for the default ports, matching browser semantics). */
function isCrossOrigin(original: URL, target: URL): boolean {
  return original.origin !== target.origin;
}

/** Remove every auth-bearing header from a header set, case-insensitively,
 *  returning a NEW Headers instance (never mutates the input). */
function stripSensitiveHeaders(headers: Headers, sensitive: ReadonlySet<string>): Headers {
  const next = new Headers();
  headers.forEach((value, key) => {
    if (!sensitive.has(key.toLowerCase())) next.set(key, value);
  });
  return next;
}

/** Build a redirect-safe fetch bound to the original configured server
 *  origin. `attachedHeaderNames` is the full set of header names we set on
 *  the outbound request (resolved auth + operator custom headers); all of
 *  them are stripped on a cross-origin hop, in addition to the always-
 *  sensitive `Authorization` / `X-API-Key`. */
export function buildSafeFetch(
  configuredUrl: string | URL,
  attachedHeaderNames: readonly string[],
  fetchImpl: SafeFetch = globalThis.fetch,
): SafeFetch {
  const originUrl = new URL(configuredUrl.toString());
  const sensitive = new Set<string>([
    ...ALWAYS_SENSITIVE,
    ...attachedHeaderNames.map((h) => h.toLowerCase()),
  ]);

  return async (url, init) => {
    let currentUrl = new URL(url.toString());
    // Start from the caller's headers; clone so we never mutate the SDK's.
    let headers = new Headers(init?.headers);
    let redirects = 0;

    while (true) {
      const response = await fetchImpl(currentUrl, {
        ...init,
        headers,
        redirect: 'manual',
      });

      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get('location');
      if (!isRedirect || !location) return response;

      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new Error('invalid redirect Location header');
      }

      // The crux: once a hop leaves the configured origin, drop every
      // header we attached so secrets never travel to a third party.
      if (isCrossOrigin(originUrl, nextUrl)) {
        headers = stripSensitiveHeaders(headers, sensitive);
      }

      currentUrl = nextUrl;
      redirects += 1;
    }
  };
}
