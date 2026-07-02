// Redaction (Phase 13.1, Invariant #15). Snapshots HARNESS_REDACT_SECRETS
// at import time so an agent can't disable redaction mid-session by
// `process.env`-mutating tool calls. The flag defaults to ON; only
// HARNESS_REDACT_SECRETS=0 (or =false / =off / =no) disables.
//
// The redactor walks a fixed set of patterns (API keys, bearer tokens,
// known secret-file paths, JWT-like strings) and replaces matches with
// `[REDACTED]`. Conservative on purpose — false positives are cheap;
// false negatives leak secrets into trajectory archives that may be
// committed to a repo.

import {
  MAX_REDACTION_INPUT_BYTES,
  compilePemPrivateKeyPattern,
  compileVendorSecretPatterns,
} from '../redaction/secretPatterns.js';

/** Snapshotted at import time per Invariant #15. */
const REDACTION_ENABLED: boolean = (() => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.HARNESS_REDACT_SECRETS;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'off' ||
    normalized === 'no'
  );
})();

/** Test seam — exposes the snapshotted flag without mutating it. */
export function isRedactionEnabled(): boolean {
  return REDACTION_ENABLED;
}

const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // Anthropic API keys.
  { name: 'anthropic', regex: /\bsk-ant-[a-zA-Z0-9_\-]{20,}\b/g },
  // OpenAI API keys (sk-, sk-proj-, sk-svcacct-).
  { name: 'openai', regex: /\bsk-(?:proj-|svcacct-)?[a-zA-Z0-9_\-]{20,}\b/g },
  // Tavily.
  { name: 'tavily', regex: /\btvly-[a-zA-Z0-9_\-]{16,}\b/g },
  // Brave Search API.
  { name: 'brave', regex: /\bBSA[a-zA-Z0-9_\-]{20,}\b/g },
  // OpenRouter.
  { name: 'openrouter', regex: /\bsk-or-[a-zA-Z0-9_\-]{20,}\b/g },
  // Vendor formats shared with permissions/secretRedactor.ts (single source of
  // truth in redaction/secretPatterns.ts): the GitHub token family gh[oprsu]_
  // (audit C5 — previously ONLY ghp_ here, leaking gho_/ghu_/ghs_/ghr_), the
  // GitHub fine-grained PAT github_pat_, the AWS access-key id AKIA…, Stripe
  // secret `[sr]k_live_/[sr]k_test_` (underscore form — the OpenAI `sk-` hyphen
  // pattern above does NOT match it), Stripe publishable `pk_...`, Slack
  // `xox[abprs]-`, Google `AIza...`. Closes the audit-F4/C5 asymmetry so every
  // token known to the tool-input redactor is also stripped from the persistent
  // transcript/trace JSONL.
  ...compileVendorSecretPatterns(),
  // Generic bearer tokens.
  { name: 'bearer', regex: /\bBearer\s+[a-zA-Z0-9_\-\.=]{16,}/g },
  // JWT-ish three-segment base64.
  {
    name: 'jwt',
    regex: /\beyJ[a-zA-Z0-9_\-=]{10,}\.eyJ[a-zA-Z0-9_\-=]{10,}\.[a-zA-Z0-9_\-=]{10,}\b/g,
  },
  // Authorization headers in serialized JSON / curl. Two forms: a plain JSON
  // key (`"authorization":"…"`) and an escaped key inside a stringified-JSON
  // value (`\"authorization\":\"…\"`) — the latter is the common case when a
  // tool result carries JSON as a string and the whole record is stringified
  // again before redaction (audit 2026-06-10). The bearer/api-key patterns
  // already catch token VALUES; this also masks Basic-auth and other schemes.
  { name: 'auth-header', regex: /"authorization"\s*:\s*"[^"]+"/gi },
  { name: 'auth-header-escaped', regex: /\\"authorization\\"\s*:\s*\\"[^"\\]+\\"/gi },
  // Common credential file paths (we don't read them; we redact references to them).
  { name: 'aws-creds-path', regex: /\B~\/\.aws\/credentials\b/g },
  { name: 'ssh-private', regex: /\B~\/\.ssh\/id_(rsa|ed25519|ecdsa|dsa)(\.pub)?\b/g },
  // PEM-style private key blocks. Sourced from the SHARED catalog
  // (redaction/secretPatterns.ts) so this redactor and the tool-input redactor
  // (permissions/secretRedactor.ts) use ONE linear, ReDoS-safe pattern. The
  // inner span is BOUNDED ({0,8192}?) rather than an unbounded lazy `[\s\S]*?`:
  // an unbounded lazy span is O(n^2) on attacker-controlled content with many
  // `BEGIN` markers and no matching `END` — each BEGIN rescans to end-of-input
  // (audit F5/D7, a multi-MB payload blocked the event loop for ~100s). 8192
  // chars comfortably covers a real private-key block (an RSA-8192 PEM is
  // ~6.4KB), so genuine keys still redact while the per-BEGIN scan is O(1).
  { name: 'pem-private', regex: compilePemPrivateKeyPattern() },
];

function applyPatterns(text: string, tagged: boolean): string {
  let out = text;
  for (const { name, regex } of PATTERNS) {
    out = out.replace(regex, tagged ? `[REDACTED:${name}]` : '[REDACTED]');
  }
  return out;
}

/** Redact within a bounded synchronous budget (audit C9). Inputs at or under
 *  {@link MAX_REDACTION_INPUT_BYTES} are scanned in full. ABOVE the cap only the
 *  prefix is scanned and the unscanned tail is DROPPED with a clear marker — a
 *  committed transcript/trace archive must never carry unredacted bytes, so
 *  truncating the pathologically-large tail is safer than either scanning it
 *  (event-loop DoS) or emitting it verbatim (secret leak). */
function applyCapped(text: string, tagged: boolean): string {
  if (text.length <= MAX_REDACTION_INPUT_BYTES) return applyPatterns(text, tagged);
  const head = applyPatterns(text.slice(0, MAX_REDACTION_INPUT_BYTES), tagged);
  const omitted = text.length - MAX_REDACTION_INPUT_BYTES;
  return `${head}\n[REDACTION-TRUNCATED: ${omitted} bytes over the ${MAX_REDACTION_INPUT_BYTES}-byte scan cap were dropped unscanned]`;
}

/** Apply every pattern. Returns a copy with `[REDACTED]` (or
 *  `[REDACTED:<name>]` when `tagged: true`) in place of each match.
 *
 *  When the import-time snapshot disabled redaction, returns the input
 *  unchanged. Callers do not need to check the flag themselves. */
export function redact(text: string, opts: { tagged?: boolean } = {}): string {
  if (!REDACTION_ENABLED) return text;
  return applyCapped(text, opts.tagged === true);
}

/** Test seam — runs the patterns regardless of the import-time snapshot.
 *  Used by unit tests so they don't depend on env-var setup. */
export function redactForce(text: string, opts: { tagged?: boolean } = {}): string {
  return applyCapped(text, opts.tagged === true);
}
