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

  // Audit F4 — the persistent-artifact redactor previously missed vendor
  // formats the tool-input redactor (permissions/secretRedactor.ts) already
  // detected, so a live Stripe/Slack/Google key in a tool_result was written
  // verbatim to the on-disk transcript/trace JSONL. Close the asymmetry.
  test('redacts Stripe secret keys (sk_live_ / rk_live_ underscore form)', () => {
    const sk = 'sk_live_51HabcdeFGHIJklmnoPQRST';
    const rk = 'rk_live_zzzzzzzzzzzzzzzzzzzzzzzz';
    expect(redactForce(`STRIPE_SECRET_KEY=${sk}`)).not.toContain(sk);
    expect(redactForce(`STRIPE=${rk}`)).not.toContain(rk);
    expect(redactForce(`STRIPE_SECRET_KEY=${sk}`)).toContain('[REDACTED]');
  });

  test('redacts Stripe test secret keys (sk_test_)', () => {
    const tok = 'sk_test_bbbbbbbbbbbbbbbbbbbbbbbb';
    expect(redactForce(`k=${tok}`)).not.toContain(tok);
  });

  test('redacts Stripe publishable keys (pk_live_ / pk_test_)', () => {
    const tok = 'pk_live_cccccccccccccccccccccccc';
    expect(redactForce(`pub=${tok}`)).not.toContain(tok);
    expect(redactForce(`pub=${tok}`)).toContain('[REDACTED]');
  });

  test('redacts Slack tokens (xoxb-/xoxa-/xoxp-)', () => {
    const tok = 'xoxb-1234567890-abcdefghijklmnop';
    expect(redactForce(`SLACK=${tok}`)).not.toContain(tok);
    expect(redactForce(`SLACK=${tok}`)).toContain('[REDACTED]');
  });

  test('redacts Google API keys (AIza...)', () => {
    const tok = 'AIzaSyA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // AIza + 35 chars
    expect(redactForce(`key=${tok}`)).not.toContain(tok);
    expect(redactForce(`key=${tok}`)).toContain('[REDACTED]');
  });

  test('the OpenAI sk- pattern does NOT swallow a Stripe sk_ key (regression)', () => {
    // sk-<hyphen> is OpenAI; sk_<underscore> is Stripe. The Stripe key must be
    // caught by the Stripe pattern specifically, not slip past because the
    // OpenAI pattern requires a hyphen.
    const stripe = 'sk_live_51HabcdeFGHIJklmnoPQRST';
    const tagged = redactForce(`x=${stripe}`, { tagged: true });
    expect(tagged).toContain('[REDACTED:stripe-secret-live]');
  });

  // Audit F5 — the pem-private pattern used a lazy unbounded inner span
  // (`[\s\S]*?`) that is O(n^2) on input with many BEGIN markers and no END,
  // blocking the event loop (ReDoS). The bounded form must complete fast.
  test('does not catastrophically backtrack on many BEGIN-without-END markers (ReDoS)', () => {
    // ~1.2 MB of BEGIN markers with NO matching END. Under the old unbounded
    // lazy span this is O(n^2) — each BEGIN rescans to EOF — and took ~11s here
    // (the 3.6 MB form took ~100s). The bounded {0,8192}? span makes it linear:
    // it completes in well under 200ms, so a 1s bound cleanly separates the
    // fixed linear behavior from the pathological quadratic one.
    const payload = '-----BEGIN X PRIVATE KEY-----\n'.repeat(40_000);
    const started = Date.now();
    const out = redactForce(payload);
    const elapsed = Date.now() - started;
    // No matching END exists, so nothing is redacted — but it must return fast.
    expect(out).toBe(payload);
    expect(elapsed).toBeLessThan(1000);
  });

  test('still redacts a genuine multi-line PEM block after the ReDoS fix', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      'd25NTE5AAAAIBkSpkSpqyBALmS6PHU7n/8nL6CqlNxQGLhDbcf/h2BAAAAJBmQrTmZkK0',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const out = redactForce(`pre\n${pem}\npost`);
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEA');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('pre');
    expect(out).toContain('post');
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
