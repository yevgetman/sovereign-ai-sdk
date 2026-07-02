// Audit G6 [MEDIUM] — shared PEM bounded-scan worst-case cost.
//
// The lazy-bounded PEM pattern `-----BEGIN … PRIVATE KEY-----[\s\S]{0,W}?
// -----END …` is consumed by BOTH redactors, each scanning up to
// MAX_REDACTION_INPUT_BYTES chars. At the ORIGINAL bounds (256 KiB cap / 8192
// window) an adversarial BEGIN-spam blob (many BEGIN markers, no END) drove the
// worst-case synchronous String.replace OVER the 100ms design bar with NO
// headroom (~104ms avg on node v25). Each of ~cap/27 BEGIN start positions
// triggered a full W-step lazy END-probe → ~cap/27 × W work.
//
// The fix restores true headroom by BOUNDING that work lower: a modestly lower
// cap (256→128 KiB) AND a smaller-but-key-safe window (8192→6144). The window
// stays comfortably above a realistic RSA/EC private-key body (~1.6–3.2 KB
// base64), so genuine keys still redact; the total per-pass work drops to
// ~cap/27 × W and the worst-case wall time falls well under the bar.

import { describe, expect, test } from 'bun:test';
import { redactSecrets } from '@yevgetman/sov-sdk/permissions/secretRedactor';
import {
  MAX_REDACTION_INPUT_BYTES,
  PEM_PRIVATE_KEY_BLOCK_SOURCE,
} from '@yevgetman/sov-sdk/redaction/secretPatterns';
import { redactForce } from '@yevgetman/sov-sdk/trajectory/redact';

// The bounded inner-span limit `{0,W}?` from the shared PEM source.
function pemWindow(): number {
  const m = PEM_PRIVATE_KEY_BLOCK_SOURCE.match(/\{0,(\d+)\}\?/);
  if (!m) throw new Error('PEM source no longer carries a bounded {0,W}? span');
  return Number.parseInt(m[1] as string, 10);
}

// Minimal-marker BEGIN-spam sized to the scan cap: the densest worst case (most
// BEGIN start positions), no matching END anywhere → every BEGIN runs a full
// window probe.
function beginSpam(bytes: number): string {
  const marker = '-----BEGIN PRIVATE KEY-----';
  return marker.repeat(Math.ceil(bytes / marker.length)).slice(0, bytes);
}

// A genuine, realistically-sized PEM private-key block (base64 body wrapped at
// 64 chars/line, like real PEM output).
function genuinePem(bodyChars: number, label = 'RSA'): string {
  const b64 = 'A'.repeat(bodyChars);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label} PRIVATE KEY-----\n${lines.join('\n')}\n-----END ${label} PRIVATE KEY-----`;
}

describe('PEM redaction bounds (audit G6)', () => {
  // Deterministic guard on the total worst-case work: cap × window. Pins the
  // fix so neither bound can silently drift back to a pathological pair.
  test('scan cap is bounded to keep worst-case work under the 100ms bar', () => {
    expect(MAX_REDACTION_INPUT_BYTES).toBeLessThanOrEqual(131072);
  });

  test('PEM window is small enough for headroom yet above a real key body', () => {
    const w = pemWindow();
    expect(w).toBeLessThanOrEqual(6144); // headroom under the time bar
    expect(w).toBeGreaterThanOrEqual(4096); // still above a realistic key body
  });

  // Behavioral acceptance: the worst-case adversarial payload, run through the
  // ACTUAL redactors (each slices to its own cap), completes under the 100ms
  // design bar — with the fixed bounds it clears it with wide margin.
  test('worst-case BEGIN-spam redacts under the 100ms design bar (persistent redactor)', () => {
    const payload = beginSpam(MAX_REDACTION_INPUT_BYTES);
    const t0 = performance.now();
    redactForce(payload);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  test('worst-case BEGIN-spam redacts under the 100ms design bar (tool-input redactor)', () => {
    const payload = beginSpam(MAX_REDACTION_INPUT_BYTES);
    const t0 = performance.now();
    redactSecrets(payload);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  // Key-safety: a realistically-sized private-key block (RSA-2048 ~1.6 KB and
  // RSA-4096 ~3.2 KB bodies) is STILL fully redacted after shrinking the window.
  test('a genuine RSA-2048-sized PEM block is still fully redacted', () => {
    const pem = genuinePem(1600);
    expect(redactForce(pem)).not.toContain('PRIVATE KEY');
    expect(redactForce(pem)).toContain('[REDACTED]');
    expect(redactSecrets(`pre\n${pem}\npost`).redacted).toContain('<REDACTED:private-key-block>');
  });

  test('a genuine RSA-4096-sized PEM block is still fully redacted', () => {
    const pem = genuinePem(3200);
    expect(redactForce(pem)).not.toContain('PRIVATE KEY');
    expect(redactSecrets(`pre\n${pem}\npost`).redacted).toContain('<REDACTED:private-key-block>');
  });

  // No false positives: benign content (including a bare BEGIN with no END) is
  // untouched by the PEM pattern.
  test('normal content is unaffected', () => {
    const text = 'the quick brown fox\n-----BEGIN NOTES-----\njust prose\n';
    expect(redactForce(text)).toBe(text);
  });
});
