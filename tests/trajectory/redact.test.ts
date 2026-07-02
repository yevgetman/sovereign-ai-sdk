// Phase 13.1 — secret-redaction patterns. Uses redactForce so tests
// don't depend on the import-time HARNESS_REDACT_SECRETS snapshot.

import { describe, expect, test } from 'bun:test';
import { isRedactionEnabled, redactForce } from '@yevgetman/sov-sdk/trajectory/redact';

describe('redactForce', () => {
  test('redacts Anthropic API keys', () => {
    const text = 'header: x-api-key: sk-ant-api03-abc123ABC_xyz-_-deadBEEFdead';
    const out = redactForce(text);
    expect(out).not.toContain('sk-ant-');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts OpenAI API keys (sk-, sk-proj-, sk-svcacct-)', () => {
    expect(redactForce('OPENAI_API_KEY=sk-deadbeef1234567890aBcDeFgHiJ')).toContain('[REDACTED]');
    expect(redactForce('sk-proj-aBcDef1234567890_-zyxwvut')).toContain('[REDACTED]');
    expect(redactForce('sk-svcacct-Z9YxW8vU7tS6rQ5pO4n3M2lKj')).toContain('[REDACTED]');
  });

  test('redacts Tavily and Brave keys', () => {
    expect(redactForce('webSearch.apiKey=tvly-abcdef1234567890ABCDEF')).toContain('[REDACTED]');
    expect(redactForce('x-subscription-token: BSA1234567890abcdefghijkl')).toContain('[REDACTED]');
  });

  test('redacts OpenRouter keys', () => {
    expect(redactForce('export OPENROUTER_API_KEY=sk-or-aBcDeF1234567890xYz')).toContain(
      '[REDACTED]',
    );
  });

  test('redacts GitHub PATs', () => {
    expect(redactForce('ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ')).toContain('[REDACTED]');
    expect(redactForce(`github_pat_${'a'.repeat(70)}`)).toContain('[REDACTED]');
  });

  test('redacts AWS access key ids', () => {
    expect(redactForce('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
  });

  test('redacts bearer tokens in Authorization headers', () => {
    expect(redactForce('Authorization: Bearer abc.def.ghi-jkl_MNO1234567')).toContain('[REDACTED]');
  });

  test('redacts JWT-shaped tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEyMzQ1Njc4OTAsIm5hbWUiOiJKb2huIERvZSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactForce(jwt)).toContain('[REDACTED]');
  });

  test('redacts authorization headers in serialized JSON', () => {
    const out = redactForce('{"authorization": "Bearer secrettoken123"}');
    expect(out).not.toContain('secrettoken123');
  });

  // Audit 2026-06-10 — the common production shape is a tool result carrying
  // JSON as a STRING, re-stringified before redaction, so the quotes are
  // escaped. The Basic-auth value has no Bearer/api-key shape, so only the
  // auth-header pattern can catch it.
  test('redacts escaped-quote authorization headers (Basic auth in stringified JSON)', () => {
    const record = JSON.stringify({
      output: JSON.stringify({ authorization: 'Basic dXNlcjpwdw==' }),
    });
    expect(record).toContain('\\"authorization\\"'); // confirm the escaped shape
    const out = redactForce(record);
    expect(out).not.toContain('dXNlcjpwdw==');
  });

  test('redacts PEM private key blocks', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...lots\n-----END RSA PRIVATE KEY-----';
    expect(redactForce(pem)).not.toContain('PRIVATE KEY');
    expect(redactForce(pem)).toContain('[REDACTED]');
  });

  test('redacts ssh private key path references', () => {
    expect(redactForce('cat ~/.ssh/id_ed25519')).toContain('[REDACTED]');
  });

  test('redacts aws credentials path', () => {
    expect(redactForce('cat ~/.aws/credentials')).toContain('[REDACTED]');
  });

  test('preserves non-secret text unchanged', () => {
    const text = 'Read /etc/hosts and report the configured 127.0.0.1 entries';
    expect(redactForce(text)).toBe(text);
  });

  test('tagged: true emits per-pattern labels', () => {
    const out = redactForce('export ANTHROPIC_API_KEY=sk-ant-test_aBc-1234deadbeef0123', {
      tagged: true,
    });
    expect(out).toContain('[REDACTED:anthropic]');
  });
});

describe('isRedactionEnabled', () => {
  test('returns a boolean reflecting the import-time snapshot', () => {
    expect(typeof isRedactionEnabled()).toBe('boolean');
  });
});
