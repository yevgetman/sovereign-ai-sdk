// F27 — the security-load-bearing sessionId validator for the createAgent
// boundary. A caller-supplied sessionId is UNTRUSTED: it flows verbatim into
// skill-prompt env substitution (`${HARNESS_SESSION_ID}`) and becomes a
// persistence / filesystem path key downstream. It must therefore be checked
// the moment it enters the turn loop, before any of those sinks.
//
// This is a DENYLIST, not a positive allowlist — deliberately. A sessionId is
// frequently a channel conversation key (`agent:main:<channel>:<chatType>:
// <chatId>[:<threadId>]`, src/channels/sessionKey.ts) whose trailing segments
// are externally-controlled chat ids: an SMS chatId is a phone number with a
// leading `+` (`agent:main:sms:private:+15551234567`), an email/other channel
// may carry `@`, `.`, etc. A narrow `[A-Za-z0-9._:-]` allowlist would reject
// those legitimate keys and break every phone/email-backed channel. So instead
// we reject ONLY the characters that are dangerous at the sinks the sessionId
// reaches and that never appear in a legitimate id.

/** Backtick + path separators: the backtick is the inline-shell sigil
 *  (`` `!cmd` `` / `` !`cmd` ``) that made an untrusted sessionId an RCE once
 *  substituted into a skill body (F27); `/` and `\` are path separators
 *  (traversal into the transcript/trace FS sinks — defense-in-depth over their
 *  own filename sanitizers). */
const SESSION_ID_UNSAFE_CHAR_RE = /[`/\\]/;

/** ASCII control characters (NUL..US and DEL) — never part of a legitimate id;
 *  rejected to block path/log injection. Checked by code point rather than a
 *  regex so no control byte is embedded in this source file. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Validate a caller-supplied sessionId and return it UNCHANGED when safe.
 *  Throws a clear error otherwise — chosen over silent sanitization so a
 *  legitimate id (UUID, or a channel key carrying `:`/`+`/`@`) is NEVER quietly
 *  rewritten into a different persistence key, while an inline-shell or
 *  path-traversal payload fails fast at the boundary. A `randomUUID()` and every
 *  real channel key pass unchanged. */
export function validateSessionId(sessionId: string): string {
  const isUnsafe =
    sessionId.length === 0 ||
    sessionId.includes('..') || // parent-dir traversal run
    SESSION_ID_UNSAFE_CHAR_RE.test(sessionId) ||
    hasControlChar(sessionId);
  if (isUnsafe) {
    throw new Error(
      `invalid sessionId ${JSON.stringify(sessionId)}: must be non-empty and must not contain a backtick, path separator, '..' traversal, or control character`,
    );
  }
  return sessionId;
}
