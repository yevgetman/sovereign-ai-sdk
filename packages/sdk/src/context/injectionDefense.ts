// Prompt-injection screening for local context files before they enter the
// frozen system prompt. This is intentionally conservative: suspicious files
// are represented as blocked placeholders instead of being partially trusted.

const THREAT_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /disregard\s+(?:the\s+)?system\s+prompt/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /curl\s+.+\|\s*(?:ba)?sh/i,
] as const;

// Invisible / control-format codepoints that a human reviewer cannot see but
// the model reads literally. Screened by Unicode PROPERTY escapes rather than a
// hand-enumerated list so the class cannot silently drift as new smuggling
// channels are discovered:
//   - \p{Bidi_Control} \u2014 the full bidi-control set: marks (LRM U+200E, RLM
//     U+200F, ALM U+061C), embeddings/overrides (U+202A-U+202E), and isolates
//     (U+2066-U+2069). The old enumerated class missed the three marks.
//   - \p{Default_Ignorable_Code_Point} \u2014 zero-width space/joiner/BOM, the
//     invisible-math operators (U+2061-U+2064), soft hyphen (U+00AD), the
//     Unicode Tag block (U+E0000-U+E007F, the "ASCII smuggling" vector where
//     each ASCII byte b hides as 0xE0000+b), AND the variation selectors
//     U+FE00-U+FE0F / U+E0100-U+E01EF (256 selectors that encode arbitrary
//     bytes invisibly \u2014 the direct analogue of Tag-block smuggling).
// Carve-out: U+FE0E/U+FE0F (VS15/VS16, the text/emoji presentation selectors)
// are subtracted from the class. A context/AGENTS.md/MEMORY.md file with a
// legitimate emoji (e.g. `\u26A0\uFE0F` = U+26A0 U+FE0F) is plausible, and flagging it
// would nuke the whole doc for one emoji. The bulk smuggling range
// (U+E0100-U+E01EF, 240 selectors) plus the ideographic BMP selectors
// (U+FE00-U+FE0D) stay flagged, so only these two presentation selectors are
// exempt. The `v` (unicodeSets) flag enables the [...--[...]] set subtraction.
const INVISIBLE_UNICODE = /[[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]--[\uFE0E\uFE0F]]/v;

export const CONTEXT_SIZE_LIMIT = 20_000;

export type ContextScreenResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: string };

export interface ScreenContextOptions {
  // Whether to apply the prose THREAT_PATTERNS (ignore-previous-instructions,
  // developer-mode, curl|sh, ...) as a whole-file kill-switch. Defaults to true
  // for local context files (AGENTS.md etc. — repo-supplied, lower trust). The
  // memory/recall fence path sets this false: that content is USER-OWNED and
  // already presented as informational inside a fence, so merely MENTIONING a
  // threat phrase (or storing an install snippet) must not silently drop the
  // whole block. The security-load-bearing invisible-unicode screen + size
  // truncation still run regardless.
  applyThreatPatterns?: boolean;
}

export function screenContextFile(
  filename: string,
  text: string,
  options: ScreenContextOptions = {},
): ContextScreenResult {
  const { applyThreatPatterns = true } = options;
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

  if (applyThreatPatterns) {
    for (const pattern of THREAT_PATTERNS) {
      if (pattern.test(screened)) {
        return { ok: false, reason: `matched threat pattern ${pattern.source}` };
      }
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
