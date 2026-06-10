import { describe, expect, test } from 'bun:test';
import {
  assertResolvedHostPublic,
  checkUrlAllowed,
  isPrivateAddress,
  isPrivateHost,
  normalizeMappedIpv4,
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
  test('DNS failure does not mask as a security block (returns null)', async () => {
    const lookup = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await assertResolvedHostPublic('nonexistent.invalid', lookup)).toBeNull();
  });
});

describe('ssrfGuard — isPrivateAddress', () => {
  test('classifies resolved addresses', () => {
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});
