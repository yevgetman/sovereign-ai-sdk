// Tab-completion for the input editor. Two completion shapes:
//
//   1. Slash commands: input ends with `/word`, suggestions are
//      command names that start with `word`. e.g. `/he<Tab>` →
//      `/help`. Cycles through matches if multiple share a prefix.
//
//   2. @file references: input ends with `@partial`, suggestions
//      are files / directories under the cwd whose name starts
//      with `partial`. e.g. `@src/m<Tab>` → `@src/main.ts`.
//
// For Wave 4 MVP, completion is purely textual — the editor calls
// into this module with `(text, cursorPos)` and gets back
// `{prefix, replaceFrom, suggestions}`. The editor handles cycling
// state externally (which suggestion is currently shown).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type CompletionRequest = {
  /** Full input text (just the line containing the cursor — caller
   *  flattens multi-line buffers if relevant). */
  text: string;
  /** 0-based cursor column within `text`. */
  cursor: number;
  /** Working directory root for @file completions. */
  cwd: string;
  /** Slash command names available in the current session. */
  commandNames: string[];
};

export type CompletionResult = {
  /** Index in `text` where the suggested replacement starts. The
   *  caller replaces text.slice(replaceFrom, cursor) with each
   *  suggestion. */
  replaceFrom: number;
  /** What the user has typed so far (used as the base label when
   *  no matches exist). */
  prefix: string;
  /** Best-match-first list. Empty when nothing applies. */
  suggestions: string[];
  /** Optional kind tag for the editor's status line ("/cmd" vs "@file"). */
  kind: 'slash' | 'file' | 'none';
};

const SLASH_PATTERN = /(?:^|\s)(\/[A-Za-z0-9_-]*)$/;
const AT_PATTERN = /(?:^|\s)(@[^\s@]*)$/;

export function complete(req: CompletionRequest): CompletionResult {
  const upToCursor = req.text.slice(0, req.cursor);

  const slashMatch = SLASH_PATTERN.exec(upToCursor);
  if (slashMatch) {
    const matched = slashMatch[1] ?? '';
    const replaceFrom = upToCursor.length - matched.length;
    const partial = matched.slice(1).toLowerCase();
    const suggestions = req.commandNames
      .filter((name) => name.toLowerCase().startsWith(partial))
      .sort()
      .map((name) => `/${name}`);
    return {
      replaceFrom,
      prefix: matched,
      suggestions,
      kind: 'slash',
    };
  }

  const atMatch = AT_PATTERN.exec(upToCursor);
  if (atMatch) {
    const matched = atMatch[1] ?? '';
    const replaceFrom = upToCursor.length - matched.length;
    const partial = matched.slice(1);
    const suggestions = completeFilePaths(partial, req.cwd);
    return {
      replaceFrom,
      prefix: matched,
      suggestions: suggestions.map((s) => `@${s}`),
      kind: 'file',
    };
  }

  return {
    replaceFrom: req.cursor,
    prefix: '',
    suggestions: [],
    kind: 'none',
  };
}

function completeFilePaths(partial: string, cwd: string): string[] {
  // Split partial into a directory portion + leaf prefix. Examples:
  //   ''         → list cwd
  //   'src'      → list cwd, filter to entries starting with 'src'
  //   'src/'     → list cwd/src, no leaf filter
  //   'src/ma'   → list cwd/src, filter to entries starting with 'ma'
  const sepIdx = partial.lastIndexOf('/');
  const dirPart = sepIdx === -1 ? '' : partial.slice(0, sepIdx + 1);
  const leafPart = sepIdx === -1 ? partial : partial.slice(sepIdx + 1);
  const absDir = resolve(cwd, dirPart);
  if (!existsSync(absDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // hide dotfiles by default
    if (leafPart && !entry.toLowerCase().startsWith(leafPart.toLowerCase())) continue;
    let isDir = false;
    try {
      isDir = statSync(join(absDir, entry)).isDirectory();
    } catch {
      // unreadable — skip.
      continue;
    }
    matches.push(`${dirPart}${entry}${isDir ? '/' : ''}`);
  }
  matches.sort((a, b) => {
    // Directories first, then alphabetical within each group.
    const aDir = a.endsWith('/');
    const bDir = b.endsWith('/');
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.localeCompare(b);
  });
  return matches.slice(0, 50); // cap so a huge dir doesn't blow up rendering
}
