/**
 * Anthropic consumer terms, read 2026-10-06:
 * https://code.claude.com/docs/en/legal-and-compliance
 *
 * A Max OAuth token is for Claude Code and Anthropic's own apps. This
 * build does not copy Claude Code headers and does not send the call.
 */

export const CLAUDE_MAX_TERMS_CHECKED = '2026-10-06';

export const CLAUDE_MAX_TERMS_MESSAGE =
  'Claude Max subscription HTTP is not available. Anthropic consumer terms checked on 2026-10-06 allow that login only inside Claude Code and Anthropic apps. This build does not send the call.';
