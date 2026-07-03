// Phase 13.1 — secret-redaction patterns. Uses redactForce so tests
// don't depend on the import-time HARNESS_REDACT_SECRETS snapshot.

import { describe, expect, test } from 'bun:test';
import { redactSecrets } from '@yevgetman/sov-sdk/permissions/secretRedactor';
import { MAX_REDACTION_INPUT_BYTES } from '@yevgetman/sov-sdk/redaction/secretPatterns';
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
    // No matching END exists, so nothing in the scanned prefix is redacted. The
    // ~1.2 MB input is far over the C9 scan cap, so the unscanned tail is dropped
    // with a marker (audit C9) and the pass returns fast — the bounded {0,8192}?
    // span keeps the scanned prefix linear (audit F5).
    expect(out).toContain('REDACTION-TRUNCATED');
    expect(out.length).toBeLessThan(payload.length);
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

describe('redactForce — GitHub token family (audit C5 / F4 shared catalog)', () => {
  // The persistent redactor previously carried ONLY the classic PAT (ghp_) and
  // leaked the gho_/ghu_/ghs_/ghr_ family (OAuth / user-to-server / app-install
  // / refresh) that the tool-input redactor already stripped — so those tokens
  // landed verbatim in committed samples.jsonl. Both redactors now compile the
  // gh[oprsu]_ format from the shared catalog.
  for (const prefix of ['gho_', 'ghu_', 'ghs_', 'ghr_', 'ghp_'] as const) {
    test(`redacts ${prefix} tokens`, () => {
      const tok = `${prefix}${'A'.repeat(36)}`;
      const out = redactForce(`token=${tok}`);
      expect(out).not.toContain(tok);
      expect(out).toContain('[REDACTED]');
    });
  }

  test('every kind the tool-input redactor catches is also caught by the persistent redactor', () => {
    // One representative token per SecretKind the tool-input redactor knows. The
    // persistent (committed-archive) redactor MUST be a superset — a token known
    // to one must be known to the other (audit F4/C5 parity claim).
    const samples: string[] = [
      `gho_${'A'.repeat(36)}`, // github-oauth
      `ghu_${'B'.repeat(36)}`, // github-oauth (family)
      `github_pat_${'C'.repeat(82)}`, // github-fine-grained
      'AKIAIOSFODNN7EXAMPLE', // aws-access-key-id
      'sk_live_dddddddddddddddddddddddd', // stripe-secret-live
      'sk_test_dddddddddddddddddddddddd', // stripe-secret-test
      'pk_live_dddddddddddddddddddddddd', // stripe-publishable
      'xoxb-1234567890-abcdEFGHijklMNOP', // slack-token
      `AIza${'0'.repeat(35)}`, // google-api-key
      'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcDEF123456', // jwt
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\n-----END RSA PRIVATE KEY-----', // private-key-block
    ];
    for (const tok of samples) {
      // Sanity: the tool-input redactor considers this a secret.
      expect(redactSecrets(tok).hits.length).toBeGreaterThan(0);
      // The persistent redactor must strip it too.
      expect(redactForce(tok)).not.toContain(tok);
    }
  });
});

describe('redactForce — input-size cap (audit C9 ReDoS defense)', () => {
  const BEGIN = '-----BEGIN RSA PRIVATE KEY-----\n';
  const adversarial = (bytes: number): string =>
    BEGIN.repeat(Math.ceil(bytes / BEGIN.length)).slice(0, bytes);

  test('a multi-MB adversarial PEM-spam payload redacts in <100ms', () => {
    const payload = adversarial(4 * 1024 * 1024); // 4 MiB of BEGIN markers, no END
    const t0 = performance.now();
    const out = redactForce(payload);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(100);
    // Above the cap the unscanned tail is dropped with a marker so no
    // unredacted bytes ever reach a committed archive.
    expect(out.length).toBeLessThan(payload.length);
    expect(out).toContain('REDACTION-TRUNCATED');
  });

  test('a normal-size secret is fully redacted (no over-truncation)', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\n-----END RSA PRIVATE KEY-----';
    const out = redactForce(`pre ${key} post`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('REDACTION-TRUNCATED');
    expect(out).toContain('pre');
    expect(out).toContain('post');
  });

  test('a large benign input under the cap is preserved verbatim', () => {
    // Derive from the cap so this stays valid if the cap is retuned (audit G6).
    const benign = 'x'.repeat(MAX_REDACTION_INPUT_BYTES - 1024); // just under the cap
    expect(redactForce(benign)).toBe(benign);
  });
});

// Audit (this round) — DB/connection-URL passwords leaked UNREDACTED into
// committed trajectory/transcript archives. The userinfo password in a URL
// authority (`scheme://user:PASSWORD@host`) is unambiguously delimited (a `:`..
// `@` run inside the authority, neither char allowed inside the user/password),
// so a low-false-positive, linear-time pattern strips ONLY the credential while
// the scheme and host survive. Shared via the catalog so BOTH redactors get it.
describe('redactForce — URL-authority credentials (DB/connection URLs)', () => {
  const DB_URLS = [
    {
      url: 'postgres://admin:S3cr3tP4ssw0rd@db.internal.corp:5432/production',
      password: 'S3cr3tP4ssw0rd',
      scheme: 'postgres://',
      host: 'db.internal.corp',
    },
    {
      url: 'mongodb+srv://root:hunter2GoesHere@cluster0.abcde.mongodb.net/mydb',
      password: 'hunter2GoesHere',
      scheme: 'mongodb+srv://',
      host: 'cluster0.abcde.mongodb.net',
    },
    {
      url: 'mysql://svcuser:pa55word@10.0.0.5:3306/orders',
      password: 'pa55word',
      scheme: 'mysql://',
      host: '10.0.0.5',
    },
    {
      url: 'redis://default:R3d1sP4ss@cache.example.com:6379/0',
      password: 'R3d1sP4ss',
      scheme: 'redis://',
      host: 'cache.example.com',
    },
  ] as const;

  for (const { url, password, scheme, host } of DB_URLS) {
    test(`redacts the password in ${scheme}user:pass@`, () => {
      const out = redactForce(url);
      expect(out).not.toContain(password); // the secret is gone
      expect(out).toContain('[REDACTED]');
      expect(out).toContain(scheme); // scheme survives (not over-redacted)
      expect(out).toContain(host); // host survives (not over-redacted)
    });
  }

  test('tagged: true labels the URL-credential hit', () => {
    const out = redactForce(DB_URLS[0].url, { tagged: true });
    expect(out).toContain('[REDACTED:url-credentials]');
  });

  test('a credential-less URL is left untouched (no over-redaction)', () => {
    const url = 'https://example.com/path';
    expect(redactForce(url)).toBe(url);
  });

  test('a URL with a user but NO password is untouched', () => {
    const url = 'https://user@example.com/x';
    expect(redactForce(url)).toBe(url);
  });

  test('host:port with no userinfo is untouched (the port colon is not a password)', () => {
    const url = 'https://example.com:8080/path';
    expect(redactForce(url)).toBe(url);
  });

  // Empty-username userinfo (`scheme://:PASSWORD@host`) — the canonical Redis-AUTH
  // URL shape — and case-insensitive schemes (RFC 3986 schemes are
  // case-insensitive). Both leaked verbatim before the class was broadened.
  test('empty-username userinfo redacts the password (redis://:pass@host)', () => {
    const url = 'redis://:superSecretPass@10.0.0.5:6379';
    const out = redactForce(url);
    expect(out).not.toContain('superSecretPass');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('redis://'); // scheme survives
    expect(out).toContain('10.0.0.5'); // host survives
  });

  test('uppercase-scheme URL credentials are redacted (Postgres://user:pass@host)', () => {
    const url = 'Postgres://appuser:hunter2pw@db.internal:5432/prod';
    const out = redactForce(url);
    expect(out).not.toContain('hunter2pw');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('Postgres://');
    expect(out).toContain('db.internal');
    // Lowercase remains covered too.
    expect(redactForce('postgres://appuser:hunter2pw@db:5432/prod')).not.toContain('hunter2pw');
  });

  test('does not backtrack on a 128 KiB lowercase run or scheme+colon spam (ReDoS)', () => {
    // A pure lowercase run is the worst case for an INLINE `scheme://` prefix —
    // the scheme char-star matches the whole run then backtracks at every start
    // position → O(n^2). The lookbehind fails in O(1) wherever no `://` precedes,
    // so the pass stays linear. Also stress a scheme-and-colon-dense payload.
    const cap = MAX_REDACTION_INPUT_BYTES;
    const lowercaseRun = 'a'.repeat(cap);
    const schemeSpam = 'x://a:b:c:'.repeat(Math.ceil(cap / 10)).slice(0, cap);
    for (const payload of [lowercaseRun, schemeSpam]) {
      const t0 = performance.now();
      redactForce(payload);
      expect(performance.now() - t0).toBeLessThan(100);
    }
  });
});

describe('isRedactionEnabled', () => {
  test('returns a boolean reflecting the import-time snapshot', () => {
    expect(typeof isRedactionEnabled()).toBe('boolean');
  });
});
