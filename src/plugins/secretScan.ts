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
  // Stripe uses an UNDERSCORE (`sk_`/`pk_`), not a hyphen — the previous `pk-`
  // entry was wrong (no real provider issues `pk-...`) and is dropped. `sk_`/
  // `pk_` cover Stripe secret + publishable keys (incl. `_live_`/`_test_`).
  { prefix: 'sk_', label: 'Stripe secret key', minLen: 12 },
  { prefix: 'pk_', label: 'Stripe publishable key', minLen: 12 },
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
 *  check, not here.
 *
 *  NOTE: the `{32,}` literal must stay in sync with `ENTROPY_MIN_LENGTH` above
 *  (a regex can't interpolate a const) — both gate the same minimum run length. */
const TOKEN_CHAR_RE = /[A-Za-z0-9_\-+=]{32,}/g;

/** Scan a single string for things that look like literal secrets. Returns a
 *  finding per distinct reason (prefix / userinfo / entropy). `path` is left
 *  empty here; the object walker stamps it. Never throws. */
export function scanForSecrets(value: string): SecretFinding[] {
  // `value` is typed `string`, so only the empty-string fast-path is reachable
  // (the redundant `typeof` half was trimmed per T1 review).
  if (value.length === 0) return [];
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
 *  non-object inputs contribute nothing. Pure — input is never mutated.
 *
 *  Two complementary signals fire per leaf:
 *   1. CONTENT — `scanForSecrets` (prefix / userinfo / entropy), location-blind.
 *   2. FIELD-TARGETING — when the leaf's TERMINAL KEY names a known credential
 *      field (`bearerToken`/`apiKey`/an `Authorization`-or-token/key header/an
 *      `env` value), the LOCATION is the signal: a baked literal there is
 *      flagged even below the entropy threshold (the documented hex blind-spot
 *      — a 64-hex secret in `apiKey` looks like a readable identifier to
 *      entropy alone). Env-var placeholders (`${X}`/`$X`) are exempt — they are
 *      the SAFE pattern (defer to env) and must not be punished. */
export function scanObjectForSecrets(input: unknown): SecretFinding[] {
  return walk(input, '', null);
}

/** Terminal field names that ARE a credential by name (case-insensitive). A
 *  non-placeholder literal in one of these is treated as a baked secret. */
const CREDENTIAL_FIELD_NAMES = new Set(['bearertoken', 'apikey', 'token', 'password', 'secret']);

/** Header names that carry a credential by convention. Matched against the
 *  terminal key when the field sits under a `headers` map. */
function isCredentialHeaderName(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === 'authorization' ||
    lower === 'proxy-authorization' ||
    lower.endsWith('-api-key') ||
    lower.endsWith('-token') ||
    lower === 'x-api-key' ||
    lower === 'cookie'
  );
}

/** Min length of opaque material before a credential-FIELD literal is flagged
 *  by location. Below the entropy bar (32) on purpose — location, not entropy,
 *  is the signal — but high enough to skip trivial values like `"true"`. */
const FIELD_TARGET_MIN_LENGTH = 8;

/** True for an env-var placeholder (`${VAR}` / `$VAR`) — the SAFE pattern that
 *  defers the real secret to the environment. Exempt from field-targeting so
 *  good behaviour is never flagged. */
function isEnvPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return /^\$\{[^}]+\}$/.test(trimmed) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed);
}

/** True for a value that looks like a FILE PATH (absolute `/…`, `~`-home,
 *  `./`-rel, `../`-rel, or `${VAR}`-rooted). A credential-named field holding
 *  such a path (e.g. `GOOGLE_APPLICATION_CREDENTIALS=${HOME}/key.json`,
 *  `API_KEY_PATH=/home/u/k`) REFERENCES a credential file rather than embedding
 *  a secret — the safe pattern — so it is exempt from the location-based
 *  field-targeting signal. (The CONTENT scan still runs, so a real key prefix
 *  embedded inside a path is still caught.)
 *
 *  SECURITY: the exemption requires a genuine path-like PREFIX. A bare value
 *  with only an INTERIOR `/` (e.g. the AWS secret key `wJalr…/K7…/bPx…`) is far
 *  more likely a base64-standard secret than a path and is NOT exempted — it
 *  must still reach the field-target opaque-token check (which strips `/` before
 *  measuring length). Exempting any interior-`/` value let slash-containing
 *  base64/HMAC/AWS-secret keys escape both this branch AND the entropy scan
 *  (whose `TOKEN_CHAR_RE` excludes `/`), a false-negative regression. */
function isPathShaped(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return (
    trimmed.startsWith('/') ||
    trimmed.startsWith('~') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('${')
  );
}

/** True when `key` (the leaf's terminal field name) signals a credential field
 *  in the manifest credential surface. `underHeaders`/`underEnv` widen the set
 *  to header names / env-var names when the leaf sits in those maps. */
function isCredentialField(key: string, underHeaders: boolean, underEnv: boolean): boolean {
  if (CREDENTIAL_FIELD_NAMES.has(key.toLowerCase())) return true;
  if (underHeaders && isCredentialHeaderName(key)) return true;
  // An env var whose NAME hints at a credential (TOKEN/KEY/SECRET/PASSWORD).
  if (underEnv && /(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(key)) return true;
  return false;
}

/** Field-targeted finding for a credential-named leaf holding a baked literal. */
function fieldTargetFinding(value: string): SecretFinding | null {
  if (isEnvPlaceholder(value)) return null;
  // A path value references a credential FILE — the safe pattern — so it is
  // exempt from the location signal. Content findings (real key prefixes) still
  // fire via `scanForSecrets`; this only suppresses the field-targeting branch.
  if (isPathShaped(value)) return null;
  const trimmed = value.trim();
  // Pull the opaque-looking part: the longest token, or a `Scheme <token>`
  // header value's token tail. Require enough opaque chars to be a real secret.
  const tokens = trimmed.match(/[A-Za-z0-9_\-+=./]{8,}/g);
  const opaque = tokens?.some((t) => t.replace(/[./]/g, '').length >= FIELD_TARGET_MIN_LENGTH);
  if (!opaque) return null;
  return {
    path: '',
    reason: 'literal value in a credential field (field name is the signal)',
  };
}

type WalkParent = { key: string; underHeaders: boolean; underEnv: boolean } | null;

function walk(node: unknown, path: string, parent: WalkParent): SecretFinding[] {
  if (typeof node === 'string') {
    const findings = scanForSecrets(node).map((finding) => ({ ...finding, path }));
    if (parent && isCredentialField(parent.key, parent.underHeaders, parent.underEnv)) {
      const targeted = fieldTargetFinding(node);
      // Only add the field-targeted finding when the content scan missed it, so
      // a credential leaf already flagged by prefix/entropy isn't double-listed.
      if (targeted && findings.length === 0) findings.push({ ...targeted, path });
    }
    return findings;
  }
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => walk(item, joinPath(path, String(index)), parent));
  }
  if (node !== null && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) => {
      // A child is "under headers"/"under env" when EITHER this node is that
      // map (its key is `headers`/`env`) or this node was already inside one
      // (so a nested map value still counts). The child's terminal key is `key`.
      const childParent: WalkParent = {
        key,
        underHeaders: key.toLowerCase() === 'headers' || (parent?.underHeaders ?? false),
        underEnv: key.toLowerCase() === 'env' || (parent?.underEnv ?? false),
      };
      return walk(child, joinPath(path, key), childParent);
    });
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
