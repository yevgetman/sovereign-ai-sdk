// Secret-scan core detector tests (T1). The scanner is a best-effort,
// disclosed-not-made-safe literal-secret detector: it flags high-entropy
// tokens, known key prefixes, and URL userinfo so the plugin consent
// disclosure can surface "this manifest embeds what looks like a secret".
// It is NOT a security guarantee (that is the consent gate's job) — these
// tests pin the detector's behaviour, not a promise of completeness.

import { describe, expect, test } from 'bun:test';
import { scanForSecrets, scanObjectForSecrets } from '../../src/plugins/secretScan.js';

describe('scanForSecrets (string)', () => {
  test('flags an OpenAI-style sk- prefixed key', () => {
    const findings = scanForSecrets('sk-1234567890abcdef1234567890abcdef');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.reason.includes('prefix'))).toBe(true);
  });

  test('flags a GitHub personal access token (ghp_)', () => {
    const findings = scanForSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(findings.length).toBeGreaterThan(0);
  });

  test('flags a Stripe secret key (sk_)', () => {
    const findings = scanForSecrets('sk_live_1234567890abcdefghijklmnop');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.reason.includes('prefix'))).toBe(true);
  });

  test('flags a Stripe publishable key (pk_)', () => {
    const findings = scanForSecrets('pk_live_1234567890abcdefghijklmnop');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.reason.includes('prefix'))).toBe(true);
  });

  test('flags a GitHub OAuth token (gho_)', () => {
    const findings = scanForSecrets('gho_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(findings.length).toBeGreaterThan(0);
  });

  test('flags a Slack bot token (xoxb-)', () => {
    const findings = scanForSecrets('xoxb-1111111111-2222222222-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(findings.length).toBeGreaterThan(0);
  });

  test('flags an AWS access key id (AKIA)', () => {
    const findings = scanForSecrets('AKIAIOSFODNN7EXAMPLE');
    expect(findings.length).toBeGreaterThan(0);
  });

  test('flags a Google API key (AIza)', () => {
    const findings = scanForSecrets('AIzaSyA1234567890abcdefghijklmnopqrstuv');
    expect(findings.length).toBeGreaterThan(0);
  });

  test('flags URL userinfo (https://user:pass@host)', () => {
    const findings = scanForSecrets('https://admin:hunter2@example.com/path');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.reason.includes('userinfo'))).toBe(true);
  });

  test('flags a long high-entropy opaque token with no recognised prefix', () => {
    const findings = scanForSecrets('Zx9Kq7Lm2Wp4Rt6Yv8Bn1Cd3Fg5Hj0Ks2Lm4Np6Qr8');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.reason.includes('entropy'))).toBe(true);
  });

  test('does NOT flag a clean ordinary string', () => {
    expect(scanForSecrets('hello world')).toEqual([]);
  });

  test('does NOT flag a normal https URL with no credentials', () => {
    expect(scanForSecrets('https://api.example.com/v1/things')).toEqual([]);
  });

  test('does NOT flag a low-entropy English sentence below the length threshold', () => {
    expect(scanForSecrets('the quick brown fox')).toEqual([]);
  });

  test('does NOT flag a short slug', () => {
    expect(scanForSecrets('my-plugin')).toEqual([]);
  });
});

describe('scanObjectForSecrets (object string leaves)', () => {
  test('flags a secret in an mcp headers leaf with a dotted field path', () => {
    const obj = {
      mcpServers: {
        deploy: {
          type: 'http',
          url: 'https://example.com',
          headers: { Authorization: 'Bearer sk-1234567890abcdef1234567890abcdef' },
        },
      },
    };
    const findings = scanObjectForSecrets(obj);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.path === 'mcpServers.deploy.headers.Authorization')).toBe(true);
  });

  test('flags a secret in a bearerToken leaf', () => {
    const obj = { bearerToken: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' };
    const findings = scanObjectForSecrets(obj);
    expect(findings.some((f) => f.path === 'bearerToken')).toBe(true);
  });

  test('flags a secret in an apiKey leaf', () => {
    const obj = { apiKey: 'AIzaSyA1234567890abcdefghijklmnopqrstuv' };
    const findings = scanObjectForSecrets(obj);
    expect(findings.some((f) => f.path === 'apiKey')).toBe(true);
  });

  test('flags URL userinfo embedded in a url leaf', () => {
    const obj = { url: 'https://user:s3cr3tpasswordvalue@host.example.com' };
    const findings = scanObjectForSecrets(obj);
    expect(findings.some((f) => f.path === 'url')).toBe(true);
  });

  test('walks nested arrays and records an indexed path', () => {
    const obj = { args: ['--token', 'sk-1234567890abcdef1234567890abcdef'] };
    const findings = scanObjectForSecrets(obj);
    expect(findings.some((f) => f.path === 'args.1')).toBe(true);
  });

  test('does NOT flag an object with only clean string leaves', () => {
    const obj = {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'a tidy little plugin',
      mcpServers: { deploy: { type: 'http', url: 'https://api.example.com/mcp' } },
    };
    expect(scanObjectForSecrets(obj)).toEqual([]);
  });

  test('returns [] for a non-object input', () => {
    expect(scanObjectForSecrets(null)).toEqual([]);
    expect(scanObjectForSecrets(undefined)).toEqual([]);
    expect(scanObjectForSecrets('a string')).toEqual([]);
  });
});
