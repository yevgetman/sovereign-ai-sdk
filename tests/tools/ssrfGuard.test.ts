import { describe, expect, test } from 'bun:test';
import {
  assertResolvedHostPublic,
  checkUrlAllowed,
  ipv6ToBytes,
  isPrivateAddress,
  isPrivateHost,
  normalizeMappedIpv4,
  resolvePinnedTarget,
} from '../../src/tools/ssrfGuard';

describe('ssrfGuard — normalizeMappedIpv4', () => {
  test('extracts embedded IPv4 from dotted and hex IPv4-mapped IPv6', () => {
    expect(normalizeMappedIpv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeMappedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(normalizeMappedIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
  });
  test('passes through non-mapped hosts', () => {
    expect(normalizeMappedIpv4('example.com')).toBe('example.com');
    expect(normalizeMappedIpv4('::1')).toBe('::1');
  });
});

describe('ssrfGuard — isPrivateHost (audit: IPv4-mapped IPv6 bypass)', () => {
  test('blocks literal private/loopback IPv4', () => {
    for (const h of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '172.16.0.1',
      '0.0.0.0',
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });
  test('blocks localhost names', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('foo.localhost')).toBe(true);
  });
  test('blocks IPv6 loopback/link-local/unique-local', () => {
    for (const h of ['::1', '[::1]', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });
  test('blocks IPv4-mapped IPv6 (the confirmed bypass)', () => {
    expect(isPrivateHost('[::ffff:127.0.0.1]')).toBe(true);
    expect(isPrivateHost('[::ffff:7f00:1]')).toBe(true);
    expect(isPrivateHost('[::ffff:a9fe:a9fe]')).toBe(true); // 169.254.169.254
  });
  test('allows public hosts', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
  });
});

describe('ssrfGuard — checkUrlAllowed', () => {
  test('rejects the IPv4-mapped IPv6 metadata URL', () => {
    expect(checkUrlAllowed('http://[::ffff:a9fe:a9fe]/latest/meta-data').ok).toBe(false);
    expect(checkUrlAllowed('http://[::ffff:127.0.0.1]/').ok).toBe(false);
  });
  test('rejects non-http(s) and malformed', () => {
    expect(checkUrlAllowed('ftp://example.com').ok).toBe(false);
    expect(checkUrlAllowed('not a url').ok).toBe(false);
  });
  test('allows public http(s)', () => {
    expect(checkUrlAllowed('https://example.com/x').ok).toBe(true);
  });
});

describe('ssrfGuard — assertResolvedHostPublic (DNS rebinding)', () => {
  test('blocks a public name that resolves to a private address', async () => {
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    expect(await assertResolvedHostPublic('localtest.me', lookup)).toContain('private');
  });
  test('blocks when ANY resolved address is private', async () => {
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    expect(await assertResolvedHostPublic('evil.example', lookup)).toContain('private');
  });
  test('allows a name that resolves only to public addresses', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    expect(await assertResolvedHostPublic('example.com', lookup)).toBeNull();
  });
  test('IP-literal hosts short-circuit (no DNS needed)', async () => {
    const lookup = async () => {
      throw new Error('should not be called');
    };
    expect(await assertResolvedHostPublic('93.184.216.34', lookup)).toBeNull();
  });
  test('DNS failure FAILS CLOSED (returns a block reason, not null)', async () => {
    // Regression for finding #5: a fail-open on DNS error let fetch re-resolve
    // independently and connect to a private target. The channel-reachable
    // surface must now treat a lookup error as a refusal.
    const lookup = async () => {
      throw new Error('ENOTFOUND');
    };
    const reason = await assertResolvedHostPublic('nonexistent.invalid', lookup);
    expect(reason).not.toBeNull();
    expect(reason).toContain('DNS resolution');
  });
  test('empty resolution result FAILS CLOSED', async () => {
    const lookup = async () => [];
    const reason = await assertResolvedHostPublic('empty.example', lookup);
    expect(reason).not.toBeNull();
  });
  test('bounds the lookup by the supplied timeout (slow resolver fails closed)', async () => {
    // Regression for finding #12: the lookup must honor the request timeout.
    const lookup = () => new Promise<never>(() => {}); // never resolves
    const reason = await assertResolvedHostPublic('slow.example', lookup as never, 20);
    expect(reason).not.toBeNull();
    expect(reason).toContain('failed');
  });
});

describe('ssrfGuard — isPrivateAddress', () => {
  test('classifies resolved addresses', () => {
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
  test('finding #3: blocks CGNAT 100.64.0.0/10 (RFC 6598)', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('100.100.100.200')).toBe(true); // Alibaba metadata
    expect(isPrivateAddress('100.127.255.255')).toBe(true);
    expect(isPrivateAddress('::ffff:100.64.0.1')).toBe(true);
    // Boundaries: 100.63.x and 100.128.x are public.
    expect(isPrivateAddress('100.63.255.255')).toBe(false);
    expect(isPrivateAddress('100.128.0.1')).toBe(false);
  });
  test('finding #2: blocks full ULA fc00::/7 and link-local fe80::/10', () => {
    for (const a of [
      'fc01::',
      'fc12:3456::1',
      'fcaa::1',
      'fdff::1',
      'fe80::1',
      'feaa::1', // within fe80::/10
      'febf::1', // top of fe80::/10
    ]) {
      expect(isPrivateAddress(a)).toBe(true);
    }
    // fec0:: is OUTSIDE fe80::/10 (site-local, deprecated) — must not regress.
    expect(isPrivateAddress('fc00::1')).toBe(true);
  });
  test('finding #26: canonicalizes expanded IPv6 before matching', () => {
    expect(isPrivateAddress('0:0:0:0:0:0:0:1')).toBe(true); // expanded ::1
    expect(isPrivateAddress('0:0:0:0:0:0:0:0')).toBe(true); // expanded ::
    expect(isPrivateAddress('fe80:0:0:0:0:0:0:1')).toBe(true); // expanded fe80::1
    expect(isPrivateAddress('fc00:0:0:0:0:0:0:1')).toBe(true); // expanded fc00::1
  });
  // Adversarial follow-up to the G2 fix: the IPv4-COMPATIBLE form `::a.b.c.d`
  // (::/96, distinct from the ::ffff: mapped form) embeds an IPv4 the guard
  // must also re-check — a real resolver returns `::a9fe:a9fe` for an AAAA.
  test('finding #4 residual: blocks IPv4-compatible IPv6 (::a.b.c.d)', () => {
    expect(isPrivateAddress('::169.254.169.254')).toBe(true); // ::a9fe:a9fe metadata
    expect(isPrivateAddress('::127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::100.64.0.1')).toBe(true); // CGNAT
    expect(isPrivateAddress('::a9fe:a9fe')).toBe(true); // hex form of ::169.254.169.254
    expect(isPrivateAddress('::7f00:1')).toBe(true); // hex form of ::127.0.0.1
    // A public embedded IPv4 stays allowed (not an SSRF target).
    expect(isPrivateAddress('::8.8.8.8')).toBe(false);
    // Reaches the sync gate and the resolve-and-pin path.
    expect(checkUrlAllowed('http://[::169.254.169.254]/').ok).toBe(false);
    expect(checkUrlAllowed('http://[::127.0.0.1]/').ok).toBe(false);
  });
  test('finding #4 residual: DNS-pin blocks an AAAA returning ::a9fe:a9fe', async () => {
    const target = await resolvePinnedTarget('https://evil.example/x', async () => [
      { address: '::a9fe:a9fe', family: 6 }, // ::169.254.169.254 metadata
    ]);
    expect(target.ok).toBe(false);
  });
});

describe('ssrfGuard — ipv6ToBytes canonicalization (finding #26)', () => {
  test('parses compressed and expanded forms to identical bytes', () => {
    expect(ipv6ToBytes('::1')).toEqual(ipv6ToBytes('0:0:0:0:0:0:0:1'));
    expect(ipv6ToBytes('fe80::1')).toEqual(ipv6ToBytes('fe80:0:0:0:0:0:0:1'));
  });
  test('parses IPv4-mapped embedded form', () => {
    const bytes = ipv6ToBytes('::ffff:169.254.169.254');
    expect(bytes).not.toBeNull();
    expect(bytes?.[15]).toBe(254);
  });
  test('rejects non-IPv6 input', () => {
    expect(ipv6ToBytes('8.8.8.8')).toBeNull();
    expect(ipv6ToBytes('example.com')).toBeNull();
  });
});

describe('ssrfGuard — finding #25: localhost trailing-dot FQDN', () => {
  test('blocks the localhost. and foo.localhost. forms', () => {
    expect(isPrivateHost('localhost.')).toBe(true);
    expect(isPrivateHost('foo.localhost.')).toBe(true);
    expect(checkUrlAllowed('http://localhost./').ok).toBe(false);
  });
  test('blocks trailing-dot IP literals too', () => {
    expect(isPrivateHost('127.0.0.1.')).toBe(true);
  });
});

describe('ssrfGuard — finding #2/#3 via checkUrlAllowed', () => {
  test('refuses full-range ULA + CGNAT URLs', () => {
    expect(checkUrlAllowed('http://[fc12:3456::1]/').ok).toBe(false);
    expect(checkUrlAllowed('http://[fc01::]/').ok).toBe(false);
    expect(checkUrlAllowed('http://100.64.0.1/').ok).toBe(false);
    expect(checkUrlAllowed('http://[::ffff:6440:1]/').ok).toBe(false); // ::ffff:100.64.0.1
  });
});

describe('ssrfGuard — resolvePinnedTarget (finding #4 TOCTOU / multi-IP)', () => {
  test('blocks when ANY resolved address is private (multi-IP)', async () => {
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }, // one private among many
    ];
    const pin = await resolvePinnedTarget('http://multi.example/x', lookup);
    expect(pin.ok).toBe(false);
    if (!pin.ok) expect(pin.reason).toContain('private/loopback');
  });
  test('plain http PINS to the validated IP and preserves the Host header', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const pin = await resolvePinnedTarget('http://pin.example/path?q=1', lookup);
    expect(pin.ok).toBe(true);
    if (pin.ok) {
      expect(pin.url).toBe('http://93.184.216.34/path?q=1');
      expect(pin.headers?.Host).toBe('pin.example');
    }
  });
  test('https returns unrewritten (documented residual; still resolve-validated)', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const pin = await resolvePinnedTarget('https://pin.example/', lookup);
    expect(pin.ok).toBe(true);
    if (pin.ok) {
      expect(pin.url).toBe('https://pin.example/');
      expect(pin.headers).toBeUndefined();
    }
  });
  test('IP-literal hosts short-circuit (no DNS, no rewrite)', async () => {
    const lookup = async () => {
      throw new Error('should not be called');
    };
    const pin = await resolvePinnedTarget('http://93.184.216.34/', lookup);
    expect(pin.ok).toBe(true);
    if (pin.ok) {
      expect(pin.url).toBe('http://93.184.216.34/');
      expect(pin.headers).toBeUndefined();
    }
  });
  test('finding #5: DNS error fails CLOSED (block, no fetch)', async () => {
    const lookup = async () => {
      throw new Error('SERVFAIL');
    };
    const pin = await resolvePinnedTarget('http://servfail.example/', lookup);
    expect(pin.ok).toBe(false);
  });
  test('finding #12: bounds DNS lookup by timeout (slow resolver blocks)', async () => {
    const lookup = () => new Promise<never>(() => {});
    const pin = await resolvePinnedTarget('http://slow.example/', lookup as never, 20);
    expect(pin.ok).toBe(false);
  });
});
