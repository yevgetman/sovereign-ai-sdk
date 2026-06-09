// Best-effort literal-secret detector, shared by the plugin manifest scan
// (T6 wires it across headers / bearerToken / apiKey / url-userinfo+query /
// env / bodies) and unit-tested standalone here (T1).
//
// IMPORTANT — this is NOT a security guarantee. It is *disclosed-not-made-
// safe*: it raises findings so the plugin consent disclosure can tell the
// operator "this manifest embeds what looks like a credential", and the
// operator decides. The real boundary is the consent gate (S1/S6), never
// this scanner. It will both miss real secrets (false negatives) and, rarely,
// flag innocuous high-entropy strings (false positives) — both are acceptable
// for a disclosure aid.
//
// All functions are pure: they never mutate their inputs.

/** One thing the scanner thinks looks like a secret. */
export type SecretFinding = {
  /** Dotted path to the offending string leaf (e.g. `mcpServers.x.headers.Authorization`).
   *  Empty for a bare-string scan via `scanForSecrets`. */
  path: string;
  /** Why it was flagged — human-readable, surfaced in the consent disclosure. */
  reason: string;
};

/** Known credential prefixes. A literal beginning with one of these is almost
 *  always a real key (sized to avoid matching the bare prefix word alone). */
const KNOWN_PREFIXES: ReadonlyArray<{ prefix: string; label: string; minLen: number }> = [
  { prefix: 'sk-', label: 'OpenAI/Anthropic-style key', minLen: 12 },
  { prefix: 'pk-', label: 'publishable key', minLen: 12 },
  { prefix: 'rk_', label: 'restricted key', minLen: 12 },
  { prefix: 'ghp_', label: 'GitHub personal access token', minLen: 12 },
  { prefix: 'gho_', label: 'GitHub OAuth token', minLen: 12 },
  { prefix: 'ghu_', label: 'GitHub user-to-server token', minLen: 12 },
  { prefix: 'ghs_', label: 'GitHub server-to-server token', minLen: 12 },
  { prefix: 'ghr_', label: 'GitHub refresh token', minLen: 12 },
  { prefix: 'github_pat_', label: 'GitHub fine-grained PAT', minLen: 16 },
  { prefix: 'glpat-', label: 'GitLab personal access token', minLen: 12 },
  { prefix: 'xoxb-', label: 'Slack bot token', minLen: 12 },
  { prefix: 'xoxp-', label: 'Slack user token', minLen: 12 },
  { prefix: 'xoxa-', label: 'Slack app token', minLen: 12 },
  { prefix: 'xapp-', label: 'Slack app-level token', minLen: 12 },
  { prefix: 'AKIA', label: 'AWS access key id', minLen: 16 },
  { prefix: 'ASIA', label: 'AWS temporary access key id', minLen: 16 },
  { prefix: 'AIza', label: 'Google API key', minLen: 16 },
  { prefix: 'ya29.', label: 'Google OAuth access token', minLen: 16 },
  { prefix: 'AGPA', label: 'AWS-style identifier', minLen: 16 },
];

/** Min length before a prefix-less opaque token is entropy-tested. Short
 *  high-entropy strings (uuids fragments, hashes in slugs) are too noisy. */
const ENTROPY_MIN_LENGTH = 32;
/** Shannon entropy (bits/char) above which a long token looks random/secret.
 *  Tuned to catch genuinely random mixed-case/base64url key material (~4.5-6.0,
 *  e.g. JWTs, AWS secret keys, API tokens) while NOT flagging long readable
 *  identifiers, package names, and snake_case (~3.5-4.0). Documented blind
 *  spot: a *pure-hex* secret caps at log2(16)=4.0 bits/char and overlaps the
 *  readable-identifier band, so a prefix-less hex blob can slip past the
 *  standalone entropy check — by design, since no threshold separates 64-hex
 *  from a long snake_case identifier. Hex secrets in a credential FIELD are
 *  the field-targeted scan's job (T6), where location, not entropy, is the
 *  signal. Best-effort + disclosed-not-made-safe (see file header). */
const ENTROPY_BITS_THRESHOLD = 4.0;
/** A bare token must be a contiguous run of secret-shaped chars of at least
 *  this length to be entropy-tested as a standalone literal. Deliberately
 *  EXCLUDES `/` and `.` — those are path / URL / domain / version separators,
 *  so a long file path or URL is split into short readable segments instead of
 *  one giant high-entropy "token" (a major false-positive source: T6 scans the
 *  whole manifest, including `url` and `args` path values). Opaque key material
 *  — hex, base64url, JWT segments — lives in unbroken `[A-Za-z0-9_\-+=]` runs
 *  and is still caught; credentials *inside* a URL are caught by the userinfo
 *  check, not here. */
const TOKEN_CHAR_RE = /[A-Za-z0-9_\-+=]{32,}/g;

/** Scan a single string for things that look like literal secrets. Returns a
 *  finding per distinct reason (prefix / userinfo / entropy). `path` is left
 *  empty here; the object walker stamps it. Never throws. */
export function scanForSecrets(value: string): SecretFinding[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const findings: SecretFinding[] = [];

  const prefixHit = matchKnownPrefix(value);
  if (prefixHit) {
    findings.push({ path: '', reason: `known credential prefix (${prefixHit})` });
  }

  if (hasUrlUserinfo(value)) {
    findings.push({ path: '', reason: 'URL userinfo (embedded user:password@host)' });
  }

  if (hasHighEntropyToken(value)) {
    findings.push({
      path: '',
      reason: 'high-entropy token (looks like opaque key material)',
    });
  }

  return findings;
}

/** Recursively walk an object/array's string leaves, scanning each and
 *  stamping the dotted field path onto every finding. Non-string leaves and
 *  non-object inputs contribute nothing. Pure — input is never mutated. */
export function scanObjectForSecrets(input: unknown): SecretFinding[] {
  return walk(input, '');
}

function walk(node: unknown, path: string): SecretFinding[] {
  if (typeof node === 'string') {
    return scanForSecrets(node).map((finding) => ({ ...finding, path }));
  }
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => walk(item, joinPath(path, String(index))));
  }
  if (node !== null && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
      walk(child, joinPath(path, key)),
    );
  }
  return [];
}

function joinPath(base: string, segment: string): string {
  return base === '' ? segment : `${base}.${segment}`;
}

function matchKnownPrefix(value: string): string | null {
  // Scan every whitespace-delimited token so an embedded key (e.g. inside a
  // `Bearer <key>` header or a longer command line) is still caught.
  for (const token of value.split(/\s+/)) {
    for (const { prefix, label, minLen } of KNOWN_PREFIXES) {
      if (token.startsWith(prefix) && token.length >= minLen) return label;
    }
  }
  return null;
}

function hasUrlUserinfo(value: string): boolean {
  // Match a `scheme://user:pass@host` (or `scheme://user@host`) anywhere in
  // the string. The userinfo (between `//` and `@`) must be non-empty and not
  // itself contain a `/` (which would mean the `@` is in the path, not auth).
  return /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+(?::[^/\s@]*)?@[^/\s]+/i.test(value);
}

function hasHighEntropyToken(value: string): boolean {
  const matches = value.match(TOKEN_CHAR_RE);
  if (!matches) return false;
  return matches.some(
    (token) =>
      token.length >= ENTROPY_MIN_LENGTH && shannonEntropy(token) >= ENTROPY_BITS_THRESHOLD,
  );
}

/** Shannon entropy in bits per character. */
function shannonEntropy(token: string): number {
  const counts = new Map<string, number>();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
