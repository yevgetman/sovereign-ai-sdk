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

describe('scanObjectForSecrets — field-targeting (T6 review #2)', () => {
  // Below the entropy bar, a hex blob looks like a readable identifier, so the
  // content scan misses it. The field-targeting branch flags it by LOCATION when
  // the terminal key names a credential field — and ONLY then.
  test('a sub-32-char low-entropy hex literal in a credential-named field IS flagged by location', () => {
    const findings = scanObjectForSecrets({ apiKey: 'deadbeefcafe1234deadbeef' });
    expect(findings.length).toBe(1);
    expect(findings[0]?.path).toBe('apiKey');
    expect(findings[0]?.reason.toLowerCase()).toContain('credential field');
  });

  test('the SAME value in a NON-credential field is NOT flagged by the field-targeting branch', () => {
    expect(scanObjectForSecrets({ description: 'deadbeefcafe1234deadbeef' })).toEqual([]);
  });

  test('a ${VAR} env-placeholder in a credential field is EXEMPT (the safe pattern)', () => {
    expect(scanObjectForSecrets({ apiKey: '${MY_KEY}' })).toEqual([]);
  });

  test('a $VAR env-placeholder in a credential field is EXEMPT', () => {
    expect(scanObjectForSecrets({ apiKey: '$MY_KEY' })).toEqual([]);
  });

  test('an env map with a credential-hinting NAME + a literal value IS flagged', () => {
    const findings = scanObjectForSecrets({ env: { MY_TOKEN: 'abcdef1234567890' } });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.path === 'env.MY_TOKEN')).toBe(true);
  });

  test('an env map with a credential-hinting NAME + a ${placeholder} is EXEMPT', () => {
    expect(scanObjectForSecrets({ env: { MY_TOKEN: '${MY_TOKEN}' } })).toEqual([]);
  });

  test('an Authorization header with a literal value IS flagged by header convention', () => {
    const findings = scanObjectForSecrets({ headers: { Authorization: 'abcdef1234567890xyz' } });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.path === 'headers.Authorization')).toBe(true);
  });

  test('an X-Api-Key header with a literal value IS flagged by header convention', () => {
    const findings = scanObjectForSecrets({ headers: { 'X-Api-Key': 'abcdef1234567890xyz' } });
    expect(findings.some((f) => f.path === 'headers.X-Api-Key')).toBe(true);
  });

  test('a *-token suffixed header with a literal value IS flagged by header convention', () => {
    const findings = scanObjectForSecrets({
      headers: { 'X-Session-Token': 'abcdef1234567890xyz' },
    });
    expect(findings.some((f) => f.path === 'headers.X-Session-Token')).toBe(true);
  });

  test('a trivial sub-min-length value in a credential field is NOT flagged (the floor)', () => {
    expect(scanObjectForSecrets({ password: 'abc' })).toEqual([]);
  });

  test('a value matching BOTH a known prefix AND a credential field yields exactly ONE finding (no double-listing)', () => {
    // `sk_live_0000…` hits the Stripe prefix (a content-scan finding) but stays
    // low-entropy (no entropy finding), so it isolates the field-targeting
    // double-listing guard: the prefix finding is present, the field-targeting
    // branch must NOT add a second one (`findings.length === 0` gate).
    const findings = scanObjectForSecrets({ apiKey: 'sk_live_0000000000000000' });
    expect(findings.length).toBe(1);
    expect(findings[0]?.path).toBe('apiKey');
    expect(findings[0]?.reason.toLowerCase()).toContain('prefix');
  });
});

describe('scanObjectForSecrets — path-shaped credential values (FIX 7)', () => {
  // A credential-named field that points at a credential FILE references a
  // secret rather than embedding one — it is the safe pattern and must not
  // hard-reject a legit plugin install.
  test('GOOGLE_APPLICATION_CREDENTIALS=${HOME}/key.json (env, path with placeholder) is NOT flagged', () => {
    const findings = scanObjectForSecrets({
      env: { GOOGLE_APPLICATION_CREDENTIALS: '${HOME}/key.json' },
    });
    expect(findings).toEqual([]);
  });

  test('API_KEY_PATH=/home/u/k (env, absolute path) is NOT flagged', () => {
    const findings = scanObjectForSecrets({ env: { API_KEY_PATH: '/home/u/k' } });
    expect(findings).toEqual([]);
  });

  test('a credentials field with a ~ home-relative path is NOT flagged', () => {
    const findings = scanObjectForSecrets({ env: { AWS_CREDENTIALS: '~/.aws/credentials' } });
    expect(findings).toEqual([]);
  });

  test('a credentials field with a ./ relative path is NOT flagged', () => {
    const findings = scanObjectForSecrets({ apiKey: './secrets/key.pem' });
    expect(findings).toEqual([]);
  });

  test('a credential field with an ACTUAL embedded key still flags (no regression)', () => {
    const findings = scanObjectForSecrets({ env: { MY_TOKEN: 'abcdef1234567890ghijkl' } });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.path === 'env.MY_TOKEN')).toBe(true);
  });

  test('a known-prefix key whose value happens to be path-shaped still flags by CONTENT', () => {
    // The path exemption only suppresses the LOCATION (field-targeting) signal;
    // a real key prefix is a content finding and must survive even in a path.
    const findings = scanObjectForSecrets({
      env: { CRED_PATH: '/etc/ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    });
    expect(findings.length).toBeGreaterThan(0);
  });
});
