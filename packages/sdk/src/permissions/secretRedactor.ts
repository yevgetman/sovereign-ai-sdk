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

export type SecretKind =
  | 'github-oauth' // gh[oprsu]_ + 36+ chars
  | 'github-fine-grained' // github_pat_ + 82 chars
  | 'aws-access-key-id' // AKIA + 16
  | 'stripe-secret-live' // [sr]k_live_ + 16+ chars
  | 'stripe-secret-test' // [sr]k_test_ + 16+ chars
  | 'stripe-publishable' // pk_(live|test)_ + 16+ chars
  | 'slack-token' // xox[abprs]- + tokens
  | 'google-api-key' // AIza + 35 chars
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
  // GitHub OAuth-app tokens (gho_), classic PATs (ghp_), user tokens
  // (ghu_), server tokens (ghs_), refresh tokens (ghr_). Real tokens are
  // 36 chars after the prefix; we accept 36+ to be forward-compatible.
  { kind: 'github-oauth', pattern: /\bgh[oprsu]_[A-Za-z0-9]{36,}\b/g },

  // GitHub fine-grained PATs are 82 chars after the prefix and may
  // contain underscores.
  { kind: 'github-fine-grained', pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },

  // AWS access key ID is exactly AKIA + 16 base32-ish chars.
  { kind: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },

  // Stripe secret keys: sk_ or rk_ (restricted), live or test mode.
  // Real keys are 24+ chars after the prefix; accept 16+ for
  // forward-compat and shorter test fixtures that still look real.
  { kind: 'stripe-secret-live', pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { kind: 'stripe-secret-test', pattern: /\b[sr]k_test_[A-Za-z0-9]{16,}\b/g },

  // Stripe publishable keys (pk_) — also rotateable, less catastrophic
  // but worth redacting in artifacts.
  { kind: 'stripe-publishable', pattern: /\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },

  // Slack: xoxb-, xoxa-, xoxp-, xoxr-, xoxs-, xoxe-. Format is
  // xox[type]-NNNN-NNNN-NNNN-hash; the trailing segment varies.
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },

  // Google API keys: AIza + 35 chars.
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },

  // JWTs: three base64url segments separated by dots, header starting
  // with `eyJ` (the base64 of `{"`). We require the second segment to
  // also start with `eyJ` to avoid matching arbitrary triplets.
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },

  // PEM-style private key blocks. Multi-line, includes the surrounding
  // BEGIN/END markers. RSA, OPENSSH, EC, DSA, or generic.
  {
    kind: 'private-key-block',
    pattern:
      /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP |PRIVATE )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP |PRIVATE )?PRIVATE KEY-----/g,
  },
];

/** Scan a string for known secret patterns and return redaction info. */
export function redactSecrets(input: string): RedactionResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { redacted: input, hits: [] };
  }
  if (process.env.HARNESS_REDACTION === 'off') {
    return { redacted: input, hits: [] };
  }

  const rawHits: SecretHit[] = [];
  for (const { kind, pattern } of PATTERNS) {
    pattern.lastIndex = 0; // Stateful /g regexes must be reset.
    let match: RegExpExecArray | null = pattern.exec(input);
    while (match !== null) {
      rawHits.push({ kind, start: match.index, end: match.index + match[0].length });
      match = pattern.exec(input);
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
