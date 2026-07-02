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
// Audit C5 finished the unification: the GitHub token family (gh[oprsu]_), the
// GitHub fine-grained PAT (github_pat_), and the AWS access-key id (AKIA…) were
// each duplicated inline in BOTH redactors — and the two copies had already
// drifted (the persistent redactor's GitHub pattern covered ONLY ghp_ and leaked
// gho_/ghu_/ghs_/ghr_). Every vendor format common to both redactors now lives
// here, so neither can silently miss a token the other catches.
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
 * Vendor token formats shared by both redactors, in a fixed order. The `name`
 * of each entry doubles as the `SecretKind` the tool-input redactor reports, so
 * these names must stay in sync with `SecretKind` in permissions/secretRedactor.ts.
 */
export const VENDOR_SECRET_PATTERNS: readonly VendorSecretPattern[] = [
  // GitHub tokens: gho_ (OAuth), ghp_ (classic PAT), ghu_ (user-to-server),
  // ghs_ (App installation), ghr_ (refresh). Real tokens are 36 chars after the
  // prefix; 36+ is forward-compatible. Sharing the WHOLE gh[oprsu]_ family (not
  // just ghp_) is the fix for audit C5, where the persistent redactor leaked
  // gho_/ghu_/ghs_/ghr_ into committed archives.
  { name: 'github-oauth', source: String.raw`\bgh[oprsu]_[A-Za-z0-9]{36,}\b` },
  // GitHub fine-grained PATs: github_pat_ + 82 chars (underscores allowed). 50+
  // is forward/backward-compatible (the exact-82 form silently missed a length
  // change; the persistent redactor already used the lenient bound).
  { name: 'github-fine-grained', source: String.raw`\bgithub_pat_[A-Za-z0-9_]{50,}\b` },
  // AWS access key id: AKIA + 16 base32-ish chars.
  { name: 'aws-access-key-id', source: String.raw`\bAKIA[0-9A-Z]{16}\b` },
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
 * Harness/provider API-key formats: the LLM/tooling provider keys the harness
 * ITSELF carries (Anthropic, OpenRouter, OpenAI, Tavily, Brave) plus the generic
 * `Bearer <token>` form. These originally lived ONLY in trajectory/redact.ts, so
 * the tool-input redactor (permissions/secretRedactor.ts) — the SOLE guard on
 * file CONTENT an agent writes to disk — let a discovered LIVE provider key
 * through verbatim into a generated artifact (audit E3). Sharing them here makes
 * BOTH redactors cover the IDENTICAL provider-key set; a bidirectional parity
 * test (tests/redaction/parity.test.ts) pins the invariant drift-proof.
 *
 * Order is load-bearing on overlap: the specific `sk-ant-`/`sk-or-` forms are
 * declared BEFORE the generic OpenAI `sk-` so an Anthropic/OpenRouter key keeps
 * its own kind instead of being swallowed by `sk-` (the tool-input redactor
 * resolves an identical-span overlap in favor of the EARLIER pattern; the
 * persistent redactor applies patterns in list order). Every source is a narrow
 * prefix + a single bounded ASCII char class — linear-time, ReDoS-safe.
 */
export const PROVIDER_KEY_PATTERNS: readonly VendorSecretPattern[] = [
  // Anthropic (sk-ant-…). Precedes the generic OpenAI `sk-` pattern.
  { name: 'anthropic', source: String.raw`\bsk-ant-[a-zA-Z0-9_\-]{20,}\b` },
  // OpenRouter (sk-or-…). Likewise precedes the generic `sk-` pattern.
  { name: 'openrouter', source: String.raw`\bsk-or-[a-zA-Z0-9_\-]{20,}\b` },
  // OpenAI (sk-, sk-proj-, sk-svcacct-). Generic `sk-` (hyphen) — deliberately
  // does NOT match the underscore Stripe `sk_` form.
  { name: 'openai', source: String.raw`\bsk-(?:proj-|svcacct-)?[a-zA-Z0-9_\-]{20,}\b` },
  // Tavily.
  { name: 'tavily', source: String.raw`\btvly-[a-zA-Z0-9_\-]{16,}\b` },
  // Brave Search API.
  { name: 'brave', source: String.raw`\bBSA[a-zA-Z0-9_\-]{20,}\b` },
  // Generic bearer token (masks Basic-auth and other schemes' values too). No
  // trailing `\b`: it matches the `Bearer ` prefix plus the token run.
  { name: 'bearer', source: String.raw`\bBearer\s+[a-zA-Z0-9_\-\.=]{16,}` },
];

/**
 * Compile the shared provider-key patterns into FRESH global RegExp instances.
 * Returns new objects per call so no `lastIndex` state is shared across consumers.
 */
export function compileProviderKeyPatterns(): Array<{ name: string; regex: RegExp }> {
  return PROVIDER_KEY_PATTERNS.map((p) => ({ name: p.name, regex: new RegExp(p.source, 'g') }));
}

/**
 * Shared PEM / private-key-block pattern SOURCE (flag-less). Kept HERE — the one
 * source of truth — so both redactors consume the SAME linear form and it can
 * never drift back to a quadratic one in one redactor while the other stays fixed
 * (audit D7: exactly that drift — F5 bounded the span in trajectory/redact.ts but
 * left permissions/secretRedactor.ts unbounded).
 *
 * The inner span is BOUNDED (`{0,6144}?`) rather than an unbounded lazy
 * `[\s\S]+?`/`[\s\S]*?`: an unbounded lazy span is O(n^2) on attacker-controlled
 * content carrying many `-----BEGIN … PRIVATE KEY-----` markers with no matching
 * `-----END` — each BEGIN position rescans to end-of-input (a multi-MB payload
 * blocked the event loop for ~100s). The window was 8192, but at the 256 KiB
 * scan cap that still cost ~104ms worst-case (over the 100ms bar); 6144 restores
 * headroom (audit G6). 6144 chars comfortably covers a realistic RSA/EC
 * private-key block — bodies run ~1.6–3.2KB base64 (even RSA-4096 is ~3.2KB) —
 * so genuine keys still redact while the per-BEGIN scan is bounded → the whole
 * pass is linear. (An atypical RSA-8192 block is ~6.4KB and exceeds the window
 * by design: the window is kept just above realistic key sizes to bound cost.)
 * The `[A-Z ]*` label class (RSA / DSA / EC / OPENSSH / ENCRYPTED / PGP / plain)
 * is a single bounded quantifier over a literal-terminated run — no
 * nested/overlapping quantifiers.
 */
export const PEM_PRIVATE_KEY_BLOCK_SOURCE = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,6144}?-----END [A-Z ]*PRIVATE KEY-----`;

/**
 * Compile a FRESH global RegExp for the shared PEM private-key-block pattern.
 * Returns a new instance per call so its `lastIndex` is never shared between the
 * two redactors.
 */
export function compilePemPrivateKeyPattern(): RegExp {
  return new RegExp(PEM_PRIVATE_KEY_BLOCK_SOURCE, 'g');
}

/**
 * Hard cap on the number of characters either redactor will SCAN synchronously
 * (audit C9). Redaction runs on the event loop against attacker/MCP-influenceable
 * tool-result content with no upstream size cap. Even the linearized PEM pattern
 * has a large per-input constant (each `-----BEGIN … PRIVATE KEY-----` marker
 * with no nearby `END` costs a bounded per-BEGIN scan), so a many-MB payload of
 * BEGIN-spam blocks the loop for hundreds of ms. Capping the SCANNED length makes
 * worst-case wall-time bounded and pattern-independent — no present or future
 * pattern can go pathological on a huge input.
 *
 * 128 KiB (audit G6 — lowered from 256 KiB). At 256 KiB the worst-case
 * adversarial pass measured ~104ms on node v25 — OVER the 100ms bar with no
 * headroom (the "~33ms" claimed here before was falsified). Halving the cap
 * (paired with the 8192→6144 PEM window) brings the same worst case to ~39ms on
 * node / ~14ms on bun — true headroom under the bar — while 128 KiB stays far
 * larger than any realistic single secret or tool-result line. Each redactor
 * decides its own over-cap tail policy: the persistent (committed-archive)
 * redactor DROPS the unscanned tail with a marker (it must never emit unredacted
 * bytes); the tool-input redactor PRESERVES the tail verbatim (it rewrites file
 * content and must never truncate a write) but scans only the prefix.
 */
export const MAX_REDACTION_INPUT_BYTES = 131072;
