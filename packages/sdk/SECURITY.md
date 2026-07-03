# Security Posture — `@yevgetman/sov-sdk`

This document describes the security posture of the published open-core SDK: what
the SDK hardens by construction, and — just as important — where its controls are
**best-effort** rather than guarantees. It is scoped to the published package; the
private wrapper (`@yevgetman/sov`) is out of scope.

The SDK ran an exhaustive security audit and remediation (an Opus-4.8 `/code-review`
across two audit rounds, a 12-round adversarial convergence loop, and a
comprehensive shell-classifier sweep). Every above-low finding was fixed. The notes
below reflect the post-remediation state.

## Hardening delivered

- **Prompt-injection defense.** Untrusted context is screened before it reaches the
  model. An invisible-character screen uses Unicode property classes
  (`\p{Bidi_Control}` + `\p{Default_Ignorable_Code_Point}`, minus emoji variation
  selectors) to neutralize the whole bidi/tag-smuggling class rather than a
  hand-listed set of code points. Memory and recall bodies are additionally routed
  through a fence-breakout neutralizer that escapes fence-closing markers and
  `[System note` sequences, so injected content cannot break out of its quoted
  context and impersonate the harness.

- **No-disk guarantee for embedded string-provider turns.** A bare `createAgent`
  turn against an embedded string/scripted provider touches no disk. Credential and
  rate-limit state run in **memory mode** on that path (no `credentials.json` /
  `rate_limits` written to `HARNESS_HOME`); the CLI and gateway keep their normal
  on-disk behavior. Injectable `SessionStore` / `TranscriptStore` ports default to
  in-memory / no-op, so persistence happens only when a host supplies a store.

- **SSRF / DNS-rebinding guard.** Web fetches resolve and pin the target address and
  reject private, loopback, and link-local destinations; the DNS-rebinding guard is
  always on for the web-fetch and reference-fetch paths (it is not coupled to any
  transport-injection option).

- **Least-privilege on-disk permissions.** All SDK-written on-disk state — transcripts,
  traces, trajectories, consent records, config, credentials, and rate-limit files —
  is written through `secureWriteFileAtomic`, which creates files `0600` and their
  parent directories `0700` (the `HARNESS_HOME` root included). This closes the
  "atomic writer forgot the mode" drift class.

- **ReDoS-bounded secret redaction.** The redactor scans at most **128 KiB** of input
  synchronously (`MAX_REDACTION_INPUT_BYTES`), and every pattern is linear-time —
  the PEM / private-key block pattern in particular uses a bounded window
  (`{0,6144}?`) instead of an unbounded lazy span, so pathological `-----BEGIN … -----`
  spam cannot block the event loop. Worst-case redaction cost stays well under the
  100 ms bar.

- **Skill inline-shell RCE closure.** Skill loading substitutes environment values
  (e.g. `HARNESS_SESSION_ID`, `HARNESS_SKILL_DIR`) into inline-shell spans. The
  untrusted `sessionId` is denylist-validated (shell metacharacters rejected, channel
  keys preserved), and **all** substituted env values are shell-quoted at the point
  of substitution, so a value carrying `$(...)`, backticks, `;`, or quotes cannot
  break out of its span and execute.

- **Process-crash-safe tool-description assembly.** Tool descriptions are resolved
  through a shared `safeStaticToolDescription` helper that swallows a rejected async
  description Promise, and falls back to the tool name on a sync throw or a non-string
  result — so a misbehaving tool description cannot crash the host process (previously
  an unhandled rejection at several assembly sites) or corrupt the learning corpus.

## Best-effort boundaries (please read)

Two SDK controls are **defense-in-depth conveniences, not guarantees.** Treat them
as risk reduction layered on top of your real controls, never as the sole control.

### The shell read-only classifier is not a sandbox

`isShellCommandReadOnly` (used to auto-approve obviously-safe read commands under an
`allow Read` permission) is a **best-effort convenience heuristic.** It statically
inspects a shell command and, for the common read cases, lets it run without a
Bash-specific prompt. It **cannot be provably complete** against adversarial input.

The remediation closed a large set of concrete write/exec vectors (git inline-config
injection, `--output`/redirect clobbers, transparent command wrappers, `env -S`
split-strings, `sed` script write/exec commands, and more). But a static classifier
has an inherent residual tail — statically-undetectable in-band write/exec forms such
as:

- `awk` / `gawk` program-body output redirects (`awk '{print > f}'`);
- interactive pager / editor shell-escapes (`less` → `!cmd`, `vi` → `:!cmd`);
- other value-flag orderings and in-band constructs that only reveal their effect at
  runtime.

**Guidance:** in any deployment that processes untrusted input, do **not** grant a
blanket `allow Read`. Gate the `Bash` tool with an explicit allow/deny ruleset. The
real security boundary is the permission ruleset — the read-only heuristic is a
convenience on top of it, not a substitute for it.

### The secret redactor is best-effort

The secret redactor is **defense-in-depth, best-effort, and pattern-based.** It covers
common vendor API keys (including GitHub tokens/PATs, Stripe, Slack, Google, AWS
access keys, and the harness's own provider keys), PEM / private-key blocks, JWTs, and
URL-authority / database-connection credentials (`scheme://user:pass@host`). Novel or
unprefixed secret shapes may pass through unredacted. Do not rely on it as the sole
control for keeping secrets out of committed transcripts, trajectories, or generated
artifacts — scope your inputs and review what you commit.

## Accepted low / defense-in-depth items

A handful of below-above-low items are accepted and documented rather than fixed;
they carry no privilege escalation. See the "Exhaustive Audit Remediation (2026-07-02)"
section of `docs/08-roadmap/sdk-extraction-deferred-work.md` for the full list — in
brief: a skill author's own double-quoted inline-shell span can still execute
substituted `HARNESS_SKILL_DIR` content, but only for that trusted install path (the
untrusted `sessionId` cannot reach it, and whoever controls the install path already
authors the skill body); and the static shell-classifier residual tail described
above.

## Dependency advisories

- **`@anthropic-ai/sdk` — GHSA-p7fg-763f-g4gf (moderate): "Insecure Default File
  Permissions in Local Filesystem Memory Tool"** (affected `0.79.0`–`0.91.0`). The SDK
  currently pins `^0.90.0`, so `npm install` surfaces this advisory. **The vulnerable
  surface — the anthropic SDK's own local-filesystem memory tool — is not used by this
  package** (this SDK ships its own bounded memory implementation with 0700/0600
  permissions; see "Secure file permissions" above). A patched release outside the
  affected range exists upstream; bumping the pin clears the advisory and is planned,
  gated on live-API verification of the provider stream/error paths. Until then the
  advisory is informational for this package, not an exploitable defect in it.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or PR for a
suspected vulnerability. Contact the maintainer privately via the repository's
security-advisory channel (GitHub "Report a vulnerability" / private security advisory)
or the repository owner, and allow time for a fix before any public disclosure.
