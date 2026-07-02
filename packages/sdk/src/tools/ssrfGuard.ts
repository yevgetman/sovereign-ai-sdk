// SSRF guard — shared scheme + private-host gate for every server-initiated
// fetch (the WebFetch tool and the @url context reference). On a hosted gateway
// these run for untrusted callers, so a URL pointing at loopback / private /
// link-local (cloud instance-metadata 169.254.169.254) / CGNAT space must be
// refused.
//
// Three layers (audit 2026-06-10, hardened 2026-06-14):
//   1. A SYNC literal-IP check that normalizes IPv4-mapped IPv6 (`::ffff:7f00:1`
//      ≡ 127.0.0.1) and bracketed IPv6 — the previous regex-only check let
//      `http://[::ffff:127.0.0.1]/` and `[::ffff:a9fe:a9fe]` (metadata) through.
//   2. An ASYNC DNS-resolution check for hostnames: a public name that resolves
//      to a private address (DNS-rebinding / *.nip.io / localtest.me) is blocked.
//   3. RESOLVE-AND-PIN for hostnames: resolve once, validate EVERY returned
//      address, and pin the connection to a validated IP so the fetch cannot
//      independently re-resolve to a private target (DNS-rebinding TOCTOU). For
//      plain http this is true pinning (host→IP rewrite + original Host header).
//      For https the residual rebinding window is documented on
//      {@link resolvePinnedTarget}.

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
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10 (RFC 6598)
];

/** Strip IPv6 brackets and lowercase. */
function bareHost(hostname: string): string {
  return hostname
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '') // drop a single trailing FQDN dot (`localhost.`)
    .toLowerCase();
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

/**
 * Parse any textual IPv6 form (compressed `::1`, expanded
 * `0:0:0:0:0:0:0:1`, mixed `::ffff:1.2.3.4`) into its 16 bytes. Returns null
 * when the input is not a parseable IPv6 address. We canonicalize to bytes so
 * the private-range checks cannot be evaded by an alternative textual
 * representation an injectable/non-glibc resolver might return.
 */
export function ipv6ToBytes(address: string): Uint8Array | null {
  if (isIP(address) !== 6) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const expandGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups: number[] = [];
    for (const part of segment.split(':')) {
      // A trailing/embedded dotted-quad (::ffff:1.2.3.4) expands to two groups.
      if (part.includes('.')) {
        if (isIP(part) !== 4) return null;
        const [o0, o1, o2, o3] = part.split('.').map((o) => Number.parseInt(o, 10));
        if (o0 === undefined || o1 === undefined || o2 === undefined || o3 === undefined)
          return null;
        groups.push((o0 << 8) | o1, (o2 << 8) | o3);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = expandGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? expandGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  const fillCount = 8 - head.length - tail.length;
  if (halves.length === 2 ? fillCount < 0 : fillCount !== 0) return null;
  const groups = [...head, ...new Array(Math.max(0, fillCount)).fill(0), ...tail];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (const [i, group] of groups.entries()) {
    bytes[i * 2] = (group >> 8) & 255;
    bytes[i * 2 + 1] = group & 255;
  }
  return bytes;
}

/** True when the canonical 16-byte IPv6 address is loopback/private/link-local. */
function isPrivateIpv6Bytes(bytes: Uint8Array): boolean {
  const allZero = bytes.every((b) => b === 0);
  if (allZero) return true; // :: (unspecified)
  // ::1 loopback (15 zero bytes + 0x01)
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  const b0 = bytes[0] ?? 0; // length is fixed at 16; defaults satisfy the type checker
  const b1 = bytes[1] ?? 0;
  // fc00::/7 unique-local (first 7 bits === 1111110x → 0xfc or 0xfd)
  if ((b0 & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local (0xfe80 .. 0xfebf)
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;
  // Both IPv4-embedding forms re-check the embedded dotted IPv4:
  //   ::ffff:0:0/96  IPv4-mapped     (bytes 0-9 zero, bytes 10-11 == 0xff)
  //   ::/96          IPv4-compatible (bytes 0-11 zero) — deprecated, but a real
  //     resolver can return `::a9fe:a9fe` for an AAAA record, and `::169.254.169.254`
  //     parses here, so the metadata/loopback IP would otherwise slip through.
  const isMapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isCompat = bytes.slice(0, 12).every((b) => b === 0); // ::a.b.c.d (:: and ::1 already returned above)
  if (isMapped || isCompat) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return PRIVATE_IPV4_PATTERNS.some((re) => re.test(v4));
  }
  return false;
}

/** True when an IP-literal address (any form) is loopback/private/link-local. */
export function isPrivateAddress(address: string): boolean {
  const host = normalizeMappedIpv4(bareHost(address));
  if (isIP(host) === 4 || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return PRIVATE_IPV4_PATTERNS.some((re) => re.test(host));
  }
  // Canonicalize IPv6 to bytes so expanded/alternate forms (0:0:0:0:0:0:0:1)
  // cannot slip past prefix-anchored regexes from an injectable resolver.
  const bytes = ipv6ToBytes(host);
  if (bytes) return isPrivateIpv6Bytes(bytes);
  // Unparseable as canonical IPv6 (e.g. a literal still carrying a zone id) —
  // fall back to conservative prefix matching on the textual form.
  return (
    /^::1$/i.test(host) ||
    /^::$/.test(host) ||
    /^f[cd][0-9a-f]*:/i.test(host) || // fc00::/7
    /^fe[89ab][0-9a-f]*:/i.test(host) // fe80::/10
  );
}

/**
 * True when a URL hostname is a private/loopback/link-local host. Catches the
 * `localhost` name (incl. the trailing-dot FQDN form `localhost.`) and every
 * IP-literal form (incl. IPv4-mapped IPv6). Public DNS names that *resolve* to
 * private space are caught separately by {@link assertResolvedHostPublic}.
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

const DNS_TIMEOUT_MS = 10_000;

/** Bound a DNS lookup by `timeoutMs` so a hostile/slow authoritative server
 *  cannot stall a turn past the fetch timeout. node:dns lookup takes no
 *  AbortSignal, so we race it against a timer. */
async function lookupWithTimeout(
  host: string,
  lookupImpl: LookupImpl,
  timeoutMs: number,
): Promise<Array<{ address: string; family: number }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
  });
  try {
    return await Promise.race([lookupImpl(host, { all: true }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Async DNS-resolution gate: resolve a hostname and refuse if ANY resolved
 * address is private/loopback/link-local/CGNAT. Returns a reason string when
 * blocked, or null when allowed. IP-literal hosts are already covered by the
 * sync check, so they short-circuit.
 *
 * Failure semantics: a lookup error/timeout returns a BLOCK reason (fail
 * CLOSED). This surface is reachable by untrusted channel senders, and a
 * fail-open here would let `fetchImpl` re-resolve independently and connect to
 * a private target. The fetch path treats the block as a refusal.
 */
export async function assertResolvedHostPublic(
  hostname: string,
  lookupImpl: LookupImpl = dnsLookup as unknown as LookupImpl,
  timeoutMs: number = DNS_TIMEOUT_MS,
): Promise<string | null> {
  const host = bareHost(hostname);
  if (isIP(host) !== 0) return null; // literal — sync check already handled it
  let results: Array<{ address: string; family: number }>;
  try {
    results = await lookupWithTimeout(host, lookupImpl, timeoutMs);
  } catch {
    return `Refusing to fetch: DNS resolution for ${hostname} failed.`;
  }
  if (results.length === 0) {
    return `Refusing to fetch: DNS resolution for ${hostname} returned no addresses.`;
  }
  for (const r of results) {
    if (isPrivateAddress(r.address)) {
      return `Refusing to fetch: ${hostname} resolves to a private/loopback address.`;
    }
  }
  return null;
}

/** A connection target with a pinned IP. `headers` carries the original Host
 *  for a plain-http rewrite; absent for https / IP-literal targets. `reason`
 *  (when present) is a refusal — the caller must not fetch. */
export type PinnedTarget =
  | { ok: true; url: string; headers?: Record<string, string> }
  | { ok: false; reason: string };

/**
 * Resolve `rawUrl`'s hostname, validate EVERY returned address, and pin the
 * connection so the fetch cannot independently re-resolve to a private IP
 * (the DNS-rebinding TOCTOU the guard's header names).
 *
 * - IP-literal hosts: no DNS, no rewrite — already gated by checkUrlAllowed.
 * - `http://name/`: TRUE PINNING — rewrite the host to the validated IP and
 *   carry the original Host header (verified Bun honors an explicit Host).
 *   The fetch connects to exactly the address we validated.
 * - `https://name/`: returned unrewritten. A host→IP rewrite would break TLS
 *   SNI / cert validation, and Bun's fetch exposes no per-request DNS pin or
 *   custom dispatcher (it is not undici). RESIDUAL WINDOW: between this
 *   validating resolution and fetch's own connect-time resolution an attacker
 *   with a sub-millisecond-TTL record could rebind to a private IP. We
 *   minimize it via resolve-all + block-if-any-private here; a true https pin
 *   would require a custom TLS connector. Documented, accepted residual.
 */
export async function resolvePinnedTarget(
  rawUrl: string,
  lookupImpl: LookupImpl = dnsLookup as unknown as LookupImpl,
  timeoutMs: number = DNS_TIMEOUT_MS,
): Promise<PinnedTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL.' };
  }
  const host = bareHost(parsed.hostname);
  if (isIP(host) !== 0) return { ok: true, url: rawUrl }; // literal — sync-gated

  let results: Array<{ address: string; family: number }>;
  try {
    results = await lookupWithTimeout(host, lookupImpl, timeoutMs);
  } catch {
    return { ok: false, reason: `Refusing to fetch: DNS resolution for ${host} failed.` };
  }
  if (results.length === 0) {
    return {
      ok: false,
      reason: `Refusing to fetch: DNS resolution for ${host} returned no addresses.`,
    };
  }
  for (const r of results) {
    if (isPrivateAddress(r.address)) {
      return {
        ok: false,
        reason: `Refusing to fetch: ${host} resolves to a private/loopback address.`,
      };
    }
  }

  // https: no clean per-request pin in Bun — return unrewritten (residual above).
  if (parsed.protocol !== 'http:') return { ok: true, url: rawUrl };

  // http: true pin — connect to the validated IP, preserve the Host header.
  const firstResult = results[0];
  if (firstResult === undefined) {
    return {
      ok: false,
      reason: `Refusing to fetch: DNS resolution for ${host} returned no addresses.`,
    };
  }
  const pinned = firstResult.address;
  const ipHost = pinned.includes(':') ? `[${pinned}]` : pinned;
  const pinnedUrl = new URL(rawUrl);
  pinnedUrl.hostname = ipHost;
  return { ok: true, url: pinnedUrl.toString(), headers: { Host: parsed.host } };
}
