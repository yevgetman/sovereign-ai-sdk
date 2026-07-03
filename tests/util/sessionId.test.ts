import { describe, expect, test } from 'bun:test';
import { validateSessionId } from '@yevgetman/sov-sdk/util/sessionId';

// R1 (audit 2026-07-02) — the F27 sibling. The denylist rejected only backtick +
// path separators + '..' + control, so it ACCEPTED `$ ( ) ; | & < >` and
// whitespace. A caller-supplied sessionId of `$(touch MARKER)` then survived the
// boundary and, once substituted into a skill body wrapped in an author's own
// inline-shell sigil, executed via bash (RCE). The denylist must also reject the
// shell-dangerous set — while STILL accepting the legitimate channel keys (which
// carry `:` and `+`) and UUIDs, whose characters are never shell metacharacters.
describe('validateSessionId — rejects shell metacharacters', () => {
  const dangerous: Array<[string, string]> = [
    ['command substitution $()', '$(touch x)'],
    ['bare $ sigil', 'a$b'],
    ['command separator ;', 'a;rm -rf b'],
    ['pipe |', 'a|b'],
    ['background &', 'a&b'],
    ['subshell parens', 'a(b)c'],
    ['redirect <', 'a<b'],
    ['redirect >', 'a>b'],
    ['whitespace', 'a b'],
    ['tab whitespace', 'a\tb'],
    ['backtick (already rejected, kept)', 'a`b`'],
    ['path separator (already rejected, kept)', '../../etc/passwd'],
  ];
  for (const [label, value] of dangerous) {
    test(`rejects ${label}: ${JSON.stringify(value)}`, () => {
      expect(() => validateSessionId(value)).toThrow(/sessionId/);
    });
  }

  test('rejects the empty string', () => {
    expect(() => validateSessionId('')).toThrow(/sessionId/);
  });
});

describe('validateSessionId — accepts legitimate ids unchanged', () => {
  const legit: Array<[string, string]> = [
    ['a UUID', 'd2bb51f0-624d-494e-aa4c-f84b52ffb754'],
    ['a colon-delimited channel key', 'agent:main:slack:dm:U1'],
    ['an SMS channel key with a + phone number', 'agent:main:sms:private:+15551234567'],
    ['an email-bearing channel key', 'agent:main:email:private:user@example.com'],
    ['a dotted/underscored/hyphenated id', 'session_123.abc-1'],
  ];
  for (const [label, value] of legit) {
    test(`accepts ${label} unchanged: ${JSON.stringify(value)}`, () => {
      expect(validateSessionId(value)).toBe(value);
    });
  }
});
