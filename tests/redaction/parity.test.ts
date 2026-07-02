// Bidirectional secret-redactor parity (audit E3).
//
// The shared catalog (redaction/secretPatterns.ts) claims an invariant: "neither
// [redactor] can silently miss a token the other catches." Before this fix that
// was ONE-DIRECTIONAL — the persistent-artifact redactor (trajectory/redact.ts)
// was a superset, but the TOOL-INPUT redactor (permissions/secretRedactor.ts) —
// the sole guard on file CONTENT an agent writes to disk — missed the harness's
// OWN provider keys (Anthropic/OpenRouter/OpenAI/Tavily/Brave + Bearer), so a
// discovered LIVE key could be written verbatim into a generated artifact.
//
// This test makes the invariant REAL and drift-proof: a corpus with one sample
// per shared token format is redacted by BOTH redactors. The coverage assertion
// fails if a shared pattern is added without a sample, so the corpus can never
// silently fall behind the catalog.

import { describe, expect, test } from 'bun:test';
import { redactSecrets } from '@yevgetman/sov-sdk/permissions/secretRedactor';
import {
  PROVIDER_KEY_PATTERNS,
  VENDOR_SECRET_PATTERNS,
} from '@yevgetman/sov-sdk/redaction/secretPatterns';
import { redactForce } from '@yevgetman/sov-sdk/trajectory/redact';

// One representative, pattern-matching token per SHARED catalog name.
const SHARED_SAMPLES: Record<string, string> = {
  // Vendor formats.
  'github-oauth': `gho_${'A'.repeat(36)}`,
  'github-fine-grained': `github_pat_${'A'.repeat(82)}`,
  'aws-access-key-id': 'AKIAIOSFODNN7EXAMPLE',
  'stripe-secret-live': `sk_live_${'a'.repeat(24)}`,
  'stripe-secret-test': `sk_test_${'a'.repeat(24)}`,
  'stripe-publishable': `pk_live_${'a'.repeat(24)}`,
  'slack-token': 'xoxb-1234567890-abcdEFGHijklMNOP',
  'google-api-key': `AIza${'0'.repeat(35)}`,
  // Harness/provider keys — the set the tool-input redactor was missing (E3).
  anthropic: `sk-ant-api03-${'a'.repeat(24)}`,
  openrouter: `sk-or-${'a'.repeat(24)}`,
  openai: `sk-proj-${'a'.repeat(24)}`,
  tavily: `tvly-${'a'.repeat(20)}`,
  brave: `BSA${'a'.repeat(24)}`,
  bearer: `Bearer ${'a'.repeat(24)}`,
};

// jwt + private-key-block are known to BOTH redactors but are NOT part of the
// shared vendor/provider catalog (each redactor compiles them separately). Add
// them so the parity corpus is the FULL set either redactor treats as a secret.
const EXTRA_SAMPLES: Record<string, string> = {
  jwt: 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcDEF123456',
  'private-key-block':
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123deadbeef\n-----END RSA PRIVATE KEY-----',
};

const CORPUS: Record<string, string> = { ...SHARED_SAMPLES, ...EXTRA_SAMPLES };

describe('secret-redactor parity (audit E3 — bidirectional, drift-proof)', () => {
  const sharedNames = [...VENDOR_SECRET_PATTERNS, ...PROVIDER_KEY_PATTERNS].map((p) => p.name);

  test('every shared catalog pattern has a parity sample (no silent drift)', () => {
    for (const name of sharedNames) {
      expect(SHARED_SAMPLES[name]).toBeDefined();
    }
    // And no stale samples for removed patterns.
    for (const name of Object.keys(SHARED_SAMPLES)) {
      expect(sharedNames).toContain(name);
    }
  });

  for (const [name, token] of Object.entries(CORPUS)) {
    test(`both redactors redact ${name}`, () => {
      // Tool-input redactor: guards file CONTENT before it reaches disk.
      const tool = redactSecrets(token);
      expect(tool.hits.length).toBeGreaterThan(0);
      expect(tool.redacted).not.toContain(token);

      // Persistent-artifact redactor: guards committed transcript/trace JSONL.
      const persistent = redactForce(token);
      expect(persistent).not.toBe(token);
      expect(persistent).not.toContain(token);
    });
  }

  test('the provider keys the tool-input redactor previously MISSED are now caught', () => {
    // These are the exact E3 regression tokens (were verbatim before the fix).
    for (const name of ['anthropic', 'openrouter', 'openai', 'tavily', 'brave', 'bearer']) {
      const token = SHARED_SAMPLES[name];
      if (token === undefined) throw new Error(`missing sample for ${name}`);
      expect(redactSecrets(token).hits.length).toBeGreaterThan(0);
      expect(redactSecrets(token).redacted).not.toContain(token);
    }
  });
});
