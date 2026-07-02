// Shared vendor secret-token pattern catalog (OPEN — no proprietary imports).
//
// Single source of truth for the token FORMATS recognized by BOTH
// persistent-artifact redactors:
//   • trajectory/redact.ts          — redacts full-conversation transcript/trace
//                                      JSONL (files that may be committed to a repo)
//   • permissions/secretRedactor.ts — redacts Write/Edit/NotebookEdit tool inputs
//
// Before this module the two redactors carried independent pattern sets and had
// DRIFTED: the tool-input redactor knew Stripe/Slack/Google formats the
// persistent-artifact redactor did not, so a live Stripe key in a tool_result
// was written verbatim to disk (audit F4). Centralizing the shared formats here
// makes a token shape known to one redactor known to the other — permanently.
//
// Patterns are stored as regex SOURCE strings (no flags). Each consumer compiles
// its OWN `new RegExp(source, 'g')` via {@link compileVendorSecretPatterns} so
// the mutable `lastIndex` of a stateful /g regex is never shared across call
// sites. Every source is a narrow prefix + length-bounded ASCII char class
// (so `\b` boundaries are valid and false positives stay low) with NO capture
// groups and NO nested/overlapping quantifiers — i.e. linear-time, ReDoS-safe.

/** A shared vendor token format: canonical name + a flag-less regex source. */
export interface VendorSecretPattern {
  /** Canonical vendor/kind name (matches `SecretKind` in secretRedactor.ts). */
  readonly name: string;
  /** Regex source with no flags. ASCII-prefixed so `\b` boundaries are valid. */
  readonly source: string;
}

/**
 * Vendor token formats shared by both redactors, in a fixed order. Kept
 * byte-identical to the definitions permissions/secretRedactor.ts previously
 * inlined, so moving them here changes no behavior on either side.
 */
export const VENDOR_SECRET_PATTERNS: readonly VendorSecretPattern[] = [
  // Stripe secret keys: sk_ or rk_ (restricted), live or test mode. Underscore
  // form — the OpenAI `sk-` (hyphen) pattern deliberately does NOT match this.
  { name: 'stripe-secret-live', source: String.raw`\b[sr]k_live_[A-Za-z0-9]{16,}\b` },
  { name: 'stripe-secret-test', source: String.raw`\b[sr]k_test_[A-Za-z0-9]{16,}\b` },
  // Stripe publishable keys (pk_live_ / pk_test_).
  { name: 'stripe-publishable', source: String.raw`\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b` },
  // Slack tokens: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-.
  { name: 'slack-token', source: String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}\b` },
  // Google API keys: AIza + 35 chars.
  { name: 'google-api-key', source: String.raw`\bAIza[0-9A-Za-z_-]{35}\b` },
];

/**
 * Compile the shared vendor patterns into FRESH global RegExp instances. Each
 * call returns new objects so no `lastIndex` state is shared between consumers.
 */
export function compileVendorSecretPatterns(): Array<{ name: string; regex: RegExp }> {
  return VENDOR_SECRET_PATTERNS.map((p) => ({ name: p.name, regex: new RegExp(p.source, 'g') }));
}

/**
 * Shared PEM / private-key-block pattern SOURCE (flag-less). Kept HERE — the one
 * source of truth — so both redactors consume the SAME linear form and it can
 * never drift back to a quadratic one in one redactor while the other stays fixed
 * (audit D7: exactly that drift — F5 bounded the span in trajectory/redact.ts but
 * left permissions/secretRedactor.ts unbounded).
 *
 * The inner span is BOUNDED (`{0,8192}?`) rather than an unbounded lazy
 * `[\s\S]+?`/`[\s\S]*?`: an unbounded lazy span is O(n^2) on attacker-controlled
 * content carrying many `-----BEGIN … PRIVATE KEY-----` markers with no matching
 * `-----END` — each BEGIN position rescans to end-of-input (a multi-MB payload
 * blocked the event loop for ~100s). 8192 chars comfortably covers a real key
 * block (an RSA-8192 PEM is ~6.4KB), so genuine keys still redact while the
 * per-BEGIN scan is O(1) → the whole pass is linear. The `[A-Z ]*` label class
 * (RSA / DSA / EC / OPENSSH / ENCRYPTED / PGP / plain) is a single bounded
 * quantifier over a literal-terminated run — no nested/overlapping quantifiers.
 */
export const PEM_PRIVATE_KEY_BLOCK_SOURCE = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z ]*PRIVATE KEY-----`;

/**
 * Compile a FRESH global RegExp for the shared PEM private-key-block pattern.
 * Returns a new instance per call so its `lastIndex` is never shared between the
 * two redactors.
 */
export function compilePemPrivateKeyPattern(): RegExp {
  return new RegExp(PEM_PRIVATE_KEY_BLOCK_SOURCE, 'g');
}
