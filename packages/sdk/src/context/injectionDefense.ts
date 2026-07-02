// Prompt-injection screening for local context files before they enter the
// frozen system prompt. This is intentionally conservative: suspicious files
// are represented as blocked placeholders instead of being partially trusted.

const THREAT_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /disregard\s+(?:the\s+)?system\s+prompt/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /curl\s+.+\|\s*(?:ba)?sh/i,
] as const;

const INVISIBLE_UNICODE =
  /(?:\u200B|\u200C|\u200D|\u2060|\uFEFF|\u202A|\u202B|\u202C|\u202D|\u202E)/u;

export const CONTEXT_SIZE_LIMIT = 20_000;

export type ContextScreenResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: string };

export function screenContextFile(filename: string, text: string): ContextScreenResult {
  // A single leading UTF-8 BOM (U+FEFF at position 0) is benign — many
  // editors prepend one. Strip it before screening so it doesn't block the
  // whole file. Interior zero-width/bidi controls (including a non-leading
  // U+FEFF) are still flagged below.
  const screened = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const invisible = screened.match(INVISIBLE_UNICODE);
  if (invisible) {
    return {
      ok: false,
      reason: `invisible unicode ${codePointLabel(invisible[0])}`,
    };
  }

  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(screened)) {
      return { ok: false, reason: `matched threat pattern ${pattern.source}` };
    }
  }

  if (screened.length <= CONTEXT_SIZE_LIMIT) {
    return { ok: true, text: screened, truncated: false };
  }

  return {
    ok: true,
    text: `${screened.slice(0, CONTEXT_SIZE_LIMIT)}\n[TRUNCATED ${filename}: size > ${CONTEXT_SIZE_LIMIT} chars]`,
    truncated: true,
  };
}

export function blockPlaceholder(filename: string, reason: string): string {
  return `[BLOCKED ${filename}: ${reason}]`;
}

function codePointLabel(char: string): string {
  const code = char.codePointAt(0);
  return code === undefined ? 'unknown' : `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}
