import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { redactSecrets } from '@yevgetman/sov-sdk/permissions/secretRedactor';

describe('redactSecrets — pattern coverage', () => {
  test('empty string returns no hits', () => {
    const result = redactSecrets('');
    expect(result.hits).toEqual([]);
    expect(result.redacted).toBe('');
  });

  test('clean text returns no hits, redacted === input', () => {
    const text = 'The quick brown fox jumps over 123 lazy dogs.';
    const result = redactSecrets(text);
    expect(result.hits).toEqual([]);
    expect(result.redacted).toBe(text);
  });

  test('GitHub OAuth token (gho_) is redacted', () => {
    const tok = 'gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 36 chars after prefix
    const result = redactSecrets(`export GH_TOKEN="${tok}"`);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.kind).toBe('github-oauth');
    expect(result.redacted).toContain('<REDACTED:github-oauth>');
    expect(result.redacted).not.toContain(tok);
  });

  test('GitHub classic PAT (ghp_) is redacted', () => {
    const tok = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const result = redactSecrets(`token=${tok}`);
    expect(result.hits[0]?.kind).toBe('github-oauth');
    expect(result.redacted).not.toContain(tok);
  });

  test('GitHub fine-grained PAT (github_pat_) is redacted', () => {
    // 82 chars after the prefix, may contain underscores
    const body = `${'A'.repeat(60)}_${'B'.repeat(21)}`;
    const tok = `github_pat_${body}`;
    expect(body.length).toBe(82);
    const result = redactSecrets(`X=${tok}`);
    expect(result.hits[0]?.kind).toBe('github-fine-grained');
    expect(result.redacted).not.toContain(tok);
  });

  test('AWS access key ID is redacted', () => {
    const tok = 'AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(`aws_access_key_id=${tok}`);
    expect(result.hits[0]?.kind).toBe('aws-access-key-id');
    expect(result.redacted).not.toContain(tok);
  });

  test('Stripe live secret key is redacted', () => {
    const tok = 'sk_live_aaaaaaaaaaaaaaaaaaaaaaaa';
    const result = redactSecrets(`STRIPE=${tok}`);
    expect(result.hits[0]?.kind).toBe('stripe-secret-live');
    expect(result.redacted).not.toContain(tok);
  });

  test('Stripe restricted live key (rk_live_) is redacted', () => {
    const tok = 'rk_live_zzzzzzzzzzzzzzzzzzzzzzzz';
    const result = redactSecrets(tok);
    expect(result.hits[0]?.kind).toBe('stripe-secret-live');
    expect(result.redacted).not.toContain(tok);
  });

  test('Stripe test secret key is redacted', () => {
    const tok = 'sk_test_bbbbbbbbbbbbbbbbbbbbbbbb';
    const result = redactSecrets(tok);
    expect(result.hits[0]?.kind).toBe('stripe-secret-test');
  });

  test('Stripe publishable key is redacted', () => {
    const tok = 'pk_live_cccccccccccccccccccccccc';
    const result = redactSecrets(tok);
    expect(result.hits[0]?.kind).toBe('stripe-publishable');
  });

  test('Slack token is redacted', () => {
    const tok = 'xoxb-1234567890-abcdefghijklmnop';
    const result = redactSecrets(`SLACK=${tok}`);
    expect(result.hits[0]?.kind).toBe('slack-token');
    expect(result.redacted).not.toContain(tok);
  });

  test('Google API key is redacted', () => {
    const tok = 'AIzaSyA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // AIza + 35 chars
    const result = redactSecrets(`key=${tok}`);
    expect(result.hits[0]?.kind).toBe('google-api-key');
    expect(result.redacted).not.toContain(tok);
  });

  test('JWT is redacted', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiaWF0IjoxNjA5NDU5MjAwfQ.SOME_SIGNATURE_HERE';
    const result = redactSecrets(`Authorization: Bearer ${jwt}`);
    expect(result.hits[0]?.kind).toBe('jwt');
    expect(result.redacted).not.toContain(jwt);
  });

  test('PEM private key block is redacted', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      'd25NTE5AAAAIBkSpkSpqyBALmS6PHU7n/8nL6CqlNxQGLhDbcf/h2BAAAAJBmQrTmZkK0',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const result = redactSecrets(`pre\n${pem}\npost`);
    expect(result.hits[0]?.kind).toBe('private-key-block');
    expect(result.redacted).not.toContain('b3BlbnNzaC1rZXktdjEA');
    expect(result.redacted).toContain('pre');
    expect(result.redacted).toContain('post');
    expect(result.redacted).toContain('<REDACTED:private-key-block>');
  });
});

describe('redactSecrets — multiple hits and span boundaries', () => {
  test('multiple distinct secrets in one input are all redacted', () => {
    const gh = 'gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    const stripe = 'sk_live_dddddddddddddddddddddddd';
    const text = `gh=${gh}\naws=${aws}\nstripe=${stripe}\n`;
    const result = redactSecrets(text);
    expect(result.hits).toHaveLength(3);
    expect(new Set(result.hits.map((h) => h.kind))).toEqual(
      new Set(['github-oauth', 'aws-access-key-id', 'stripe-secret-live']),
    );
    expect(result.redacted).not.toContain(gh);
    expect(result.redacted).not.toContain(aws);
    expect(result.redacted).not.toContain(stripe);
  });

  test('span boundaries: text before, between, and after secrets is preserved', () => {
    const gh = 'gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const text = `BEFORE ${gh} MIDDLE ${gh} AFTER`;
    const result = redactSecrets(text);
    expect(result.hits).toHaveLength(2);
    expect(result.redacted).toBe(
      'BEFORE <REDACTED:github-oauth> MIDDLE <REDACTED:github-oauth> AFTER',
    );
  });

  test('overlapping pattern matches resolve to one hit (no double-redaction)', () => {
    // A long string of characters that begins with `gho_` but is followed
    // by something that could also match a different pattern after the
    // first hit's end. The redactor must not double-emit overlapping spans.
    const tok = 'gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 40 chars after prefix
    const result = redactSecrets(tok);
    // Only one hit, even though the pattern accepts 36+ chars.
    expect(result.hits).toHaveLength(1);
    // Replacement covers the entire token.
    expect(result.redacted).toBe('<REDACTED:github-oauth>');
  });
});

describe('redactSecrets — false-positive guards', () => {
  test('does not match short prefix-like fragments (gho_ alone, no token body)', () => {
    const result = redactSecrets('gho_ short');
    expect(result.hits).toEqual([]);
  });

  test('does not match hex strings that lack a known prefix', () => {
    const result = redactSecrets('abcdef0123456789abcdef0123456789'); // 32 hex chars
    expect(result.hits).toEqual([]);
  });

  test('does not match UUIDs', () => {
    const result = redactSecrets('id=550e8400-e29b-41d4-a716-446655440000');
    expect(result.hits).toEqual([]);
  });

  test('does not match plain text containing the word "token"', () => {
    const result = redactSecrets('Please rotate your token next quarter.');
    expect(result.hits).toEqual([]);
  });
});

describe('redactSecrets — bypass via env var', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.HARNESS_REDACTION;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      // Assigning `undefined` to an env var coerces to the literal
      // string 'undefined' on read; deletion is the only way to
      // restore the unset state.
      // biome-ignore lint/performance/noDelete: env var deletion semantics
      delete process.env.HARNESS_REDACTION;
    } else {
      process.env.HARNESS_REDACTION = originalEnv;
    }
  });

  test('HARNESS_REDACTION=off disables redaction (input passes through)', () => {
    process.env.HARNESS_REDACTION = 'off';
    const tok = 'gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const result = redactSecrets(tok);
    expect(result.hits).toEqual([]);
    expect(result.redacted).toBe(tok);
  });

  test('any other value of HARNESS_REDACTION leaves redaction on', () => {
    process.env.HARNESS_REDACTION = 'on';
    const tok = 'gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const result = redactSecrets(tok);
    expect(result.hits).toHaveLength(1);
  });
});
