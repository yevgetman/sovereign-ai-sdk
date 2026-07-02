// Detect and redact well-known secret patterns in a string.
//
// Pure function — no I/O, no side effects, deterministic for a given input.
// Used as defense-in-depth on Write/Edit/NotebookEdit inputs so an agent
// that finds a secret while exploring the system cannot accidentally
// reproduce that secret verbatim into a generated artifact.
//
// Patterns are intentionally narrow (prefix + length-bounded char class)
// to minimize false positives. Generic high-entropy heuristics are NOT
// applied — too noisy on real code. New patterns should match a known
// vendor token format exactly.
//
// Bypass: set HARNESS_REDACTION=off to disable globally. Tests that
// legitimately need to exercise redaction-skipping use that env var.

import {
  MAX_REDACTION_INPUT_BYTES,
  compilePemPrivateKeyPattern,
  compileProviderKeyPatterns,
  compileVendorSecretPatterns,
} from '../redaction/secretPatterns.js';

export type SecretKind =
  | 'github-oauth' // gh[oprsu]_ + 36+ chars
  | 'github-fine-grained' // github_pat_ + 82 chars
  | 'aws-access-key-id' // AKIA + 16
  | 'stripe-secret-live' // [sr]k_live_ + 16+ chars
  | 'stripe-secret-test' // [sr]k_test_ + 16+ chars
  | 'stripe-publishable' // pk_(live|test)_ + 16+ chars
  | 'slack-token' // xox[abprs]- + tokens
  | 'google-api-key' // AIza + 35 chars
  // Harness/provider API keys — SHARED with trajectory/redact.ts via the catalog
  // so the tool-input redactor no longer lets a discovered LIVE provider key
  // reach disk verbatim (audit E3).
  | 'anthropic' // sk-ant-…
  | 'openrouter' // sk-or-…
  | 'openai' // sk-, sk-proj-, sk-svcacct-
  | 'tavily' // tvly-…
  | 'brave' // BSA…
  | 'bearer' // Bearer <token>
  | 'jwt' // eyJ.eyJ.<sig>
  | 'private-key-block'; // -----BEGIN [...] PRIVATE KEY-----

export interface SecretHit {
  kind: SecretKind;
  /** Inclusive start index into the original string. */
  start: number;
  /** Exclusive end index into the original string. */
  end: number;
}

export interface RedactionResult {
  /** Input string with each hit replaced by `<REDACTED:kind>`. */
  redacted: string;
  /** Spans that matched, in input-order. Empty when no secrets found. */
  hits: SecretHit[];
}

interface PatternSpec {
  kind: SecretKind;
  // Regex MUST be /g and MUST NOT use capture groups (we read .index +
  // .[0]). Boundaries are handled inside each pattern as needed; \b
  // works for ASCII-prefixed tokens but not for tokens that begin with
  // punctuation, so each pattern declares its own boundary.
  pattern: RegExp;
}

// Order matters only when patterns overlap (e.g., a JWT could in
// principle look like a Stripe key). We resolve overlaps by preferring
// the LATER match in this list (more specific patterns last) — see
// removeOverlaps below.
const PATTERNS: readonly PatternSpec[] = [
  // GitHub (gh[oprsu]_ family + github_pat_), AWS (AKIA…), Stripe, Slack, and
  // Google formats all come from the SHARED catalog (redaction/secretPatterns.ts)
  // so the persistent-artifact redactor (trajectory/redact.ts) recognizes the
  // IDENTICAL set — the two can no longer drift apart (audit F4/C5). Order:
  // github-oauth, github-fine-grained, aws-access-key-id, stripe-secret-live,
  // stripe-secret-test, stripe-publishable, slack-token, google-api-key.
  ...compileVendorSecretPatterns().map(({ name, regex }) => ({
    kind: name as SecretKind,
    pattern: regex,
  })),

  // Harness/provider API keys (Anthropic/OpenRouter/OpenAI/Tavily/Brave + the
  // generic Bearer form) — the SAME shared catalog the persistent-artifact
  // redactor (trajectory/redact.ts) consumes, so an agent can no longer write a
  // discovered LIVE provider key into a generated file verbatim (audit E3). The
  // specific sk-ant-/sk-or- forms precede the generic sk- inside the catalog so
  // they keep their own kind on an identical-span overlap.
  ...compileProviderKeyPatterns().map(({ name, regex }) => ({
    kind: name as SecretKind,
    pattern: regex,
  })),

  // JWTs: three base64url segments separated by dots, header starting
  // with `eyJ` (the base64 of `{"`). We require the second segment to
  // also start with `eyJ` to avoid matching arbitrary triplets.
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },

  // PEM-style private key blocks. Multi-line, includes the surrounding
  // BEGIN/END markers (RSA, OPENSSH, EC, DSA, or generic). Sourced from the
  // SHARED catalog (redaction/secretPatterns.ts) so this redactor and the
  // persistent-artifact redactor (trajectory/redact.ts) use ONE linear,
  // ReDoS-safe pattern — the bounded inner span ({0,8192}?) cannot drift back to
  // the quadratic unbounded lazy form in one redactor while the other stays
  // fixed (audit D7, F5 sibling).
  { kind: 'private-key-block', pattern: compilePemPrivateKeyPattern() },
];

/** Scan a string for known secret patterns and return redaction info. */
export function redactSecrets(input: string): RedactionResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { redacted: input, hits: [] };
  }
  if (process.env.HARNESS_REDACTION === 'off') {
    return { redacted: input, hits: [] };
  }

  // Bound synchronous scan work (audit C9): only the first
  // MAX_REDACTION_INPUT_BYTES chars are pattern-matched. The full `input` is
  // still returned (the tail is preserved verbatim below) — this redactor
  // rewrites Write/Edit file CONTENT, so it must never truncate a write; it only
  // accepts not scanning the (pathologically large) tail. All hit indices stay
  // valid against `input` because the prefix shares the same offsets.
  const scanText =
    input.length > MAX_REDACTION_INPUT_BYTES ? input.slice(0, MAX_REDACTION_INPUT_BYTES) : input;

  const rawHits: SecretHit[] = [];
  for (const { kind, pattern } of PATTERNS) {
    pattern.lastIndex = 0; // Stateful /g regexes must be reset.
    let match: RegExpExecArray | null = pattern.exec(scanText);
    while (match !== null) {
      rawHits.push({ kind, start: match.index, end: match.index + match[0].length });
      match = pattern.exec(scanText);
    }
  }

  const hits = removeOverlaps(rawHits);
  if (hits.length === 0) return { redacted: input, hits: [] };

  // Build redacted string in one left-to-right pass.
  const parts: string[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (cursor < hit.start) parts.push(input.slice(cursor, hit.start));
    parts.push(`<REDACTED:${hit.kind}>`);
    cursor = hit.end;
  }
  if (cursor < input.length) parts.push(input.slice(cursor));

  return { redacted: parts.join(''), hits };
}

/**
 * Sort hits by start, then drop any hit whose span overlaps a previously
 * accepted hit. Pattern order in PATTERNS gives later patterns priority
 * via stable sort + first-wins-on-tie semantics: if two patterns match
 * identical spans, the one declared later in PATTERNS wins (achieved by
 * iterating PATTERNS in order, then using a stable sort that keeps the
 * later index after a tie on `start`).
 */
function removeOverlaps(rawHits: readonly SecretHit[]): SecretHit[] {
  if (rawHits.length === 0) return [];
  const sorted = [...rawHits].sort((a, b) => a.start - b.start || a.end - b.end);
  const accepted: SecretHit[] = [];
  for (const hit of sorted) {
    const last = accepted[accepted.length - 1];
    if (!last || hit.start >= last.end) {
      accepted.push(hit);
    }
  }
  return accepted;
}
