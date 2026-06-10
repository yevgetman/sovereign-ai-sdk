// SSRF guard — shared scheme + private-host gate for every server-initiated
// fetch (the WebFetch tool and the @url context reference). On a hosted gateway
// these run for untrusted callers, so a URL pointing at loopback / private /
// link-local (cloud instance-metadata 169.254.169.254) space must be refused.
//
// Two layers (audit 2026-06-10):
//   1. A SYNC literal-IP check that normalizes IPv4-mapped IPv6 (`::ffff:7f00:1`
//      ≡ 127.0.0.1) and bracketed IPv6 — the previous regex-only check let
//      `http://[::ffff:127.0.0.1]/` and `[::ffff:a9fe:a9fe]` (metadata) through.
//   2. An ASYNC DNS-resolution check for hostnames: a public name that resolves
//      to a private address (DNS-rebinding / *.nip.io / localtest.me) is blocked.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Injectable DNS resolver (defaults to node:dns/promises lookup). */
export type LookupImpl = (
  hostname: string,
  opts: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^127\./, // loopback
  /^0\./, // 0.0.0.0/8 "this host"
  /^10\./, // RFC1918
  /^169\.254\./, // link-local incl. cloud metadata 169.254.169.254
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
];

const PRIVATE_IPV6_PATTERNS: RegExp[] = [
  /^::1$/i, // loopback
  /^::$/, // unspecified
  /^fe80::/i, // link-local
  /^fc00::/i, // unique-local
  /^fd[0-9a-f]{2}:/i, // unique-local fd00::/8
];

/** Strip IPv6 brackets and lowercase. */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

/**
 * If `host` is an IPv4-mapped IPv6 address, return the embedded dotted IPv4;
 * otherwise return the host unchanged. Handles both `::ffff:127.0.0.1` and the
 * compressed-hex `::ffff:7f00:1` form WHATWG URL produces.
 */
export function normalizeMappedIpv4(host: string): string {
  const m = host.match(/^::ffff:(.+)$/i);
  if (!m) return host;
  const tail = m[1] ?? '';
  if (isIP(tail) === 4) return tail; // ::ffff:127.0.0.1
  const parts = tail.split(':');
  const hiHex = parts[0];
  const loHex = parts[1];
  if (
    parts.length === 2 &&
    hiHex !== undefined &&
    loHex !== undefined &&
    /^[0-9a-f]{1,4}$/i.test(hiHex) &&
    /^[0-9a-f]{1,4}$/i.test(loHex)
  ) {
    const hi = Number.parseInt(hiHex, 16);
    const lo = Number.parseInt(loHex, 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return host;
}

/** True when an IP-literal address (any form) is loopback/private/link-local. */
export function isPrivateAddress(address: string): boolean {
  const host = normalizeMappedIpv4(bareHost(address));
  if (isIP(host) === 4 || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return PRIVATE_IPV4_PATTERNS.some((re) => re.test(host));
  }
  return PRIVATE_IPV6_PATTERNS.some((re) => re.test(host));
}

/**
 * True when a URL hostname is a private/loopback/link-local host. Catches the
 * `localhost` name and every IP-literal form (incl. IPv4-mapped IPv6). Public
 * DNS names that *resolve* to private space are caught separately by
 * {@link assertResolvedHostPublic}.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = normalizeMappedIpv4(bareHost(hostname));
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isPrivateAddress(host);
}

export type UrlGuard = { ok: true; url: URL } | { ok: false; reason: string };

/** Sync scheme + private-host gate. Use before fetching and on every redirect. */
export function checkUrlAllowed(rawUrl: string): UrlGuard {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs are supported.' };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: 'Refusing to fetch from private/loopback host.' };
  }
  return { ok: true, url: parsed };
}

/**
 * Async DNS-resolution gate: resolve a hostname and refuse if ANY resolved
 * address is private/loopback/link-local. Returns a reason string when blocked,
 * or null when allowed. IP-literal hosts are already covered by the sync check,
 * so they short-circuit. DNS failures return null (let the fetch fail naturally
 * rather than masking a real network error as a security block).
 */
export async function assertResolvedHostPublic(
  hostname: string,
  lookupImpl: LookupImpl = dnsLookup as unknown as LookupImpl,
): Promise<string | null> {
  const host = bareHost(hostname);
  if (isIP(host) !== 0) return null; // literal — sync check already handled it
  try {
    const results = await lookupImpl(host, { all: true });
    for (const r of results) {
      if (isPrivateAddress(r.address)) {
        return `Refusing to fetch: ${hostname} resolves to a private/loopback address.`;
      }
    }
  } catch {
    return null;
  }
  return null;
}
