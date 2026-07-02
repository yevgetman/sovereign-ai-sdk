// Minimal argv tokenizer for hook command strings. Settings.json carries each
// hook command as a single string (`"command": "~/bin/audit.sh --verbose"`),
// but spawnProc requires an argv array and shell:false (Invariant #13). This
// splits the string into argv with quote and escape semantics that match the
// common subset users actually write — without invoking a shell.
//
// Supported: whitespace separation, single-quoted spans (literal), double-quoted
// spans (with `\"` and `\\` escapes), backslash-escaping outside quotes,
// leading-`~/` home expansion. Unsupported: pipes, redirects, $VAR, command
// substitution, globbing — those are shell features that belong inside the
// user's hook script, not in the spawn argv.

export class ArgvSplitError extends Error {}

export function argvSplit(input: string, opts: { home?: string } = {}): string[] {
  const home = opts.home ?? process.env.HOME ?? '';
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        const next = input[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
        } else {
          current += ch;
        }
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      current += ch;
      continue;
    }

    // Detect an unquoted `~/` at the *start* of a new token. Substitute the
    // home directory inline; the regular branch can't do this because it
    // doesn't know whether `~` opened the token or appeared mid-token.
    if (!hasContent && home && ch === '~' && input[i + 1] === '/') {
      current = `${home}/`;
      hasContent = true;
      i++; // skip the `/` we already consumed
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (ch === '\\') {
      const next = input[i + 1];
      if (next !== undefined) {
        current += next;
        i++;
        hasContent = true;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += ch;
    hasContent = true;
  }

  if (inSingle || inDouble) {
    throw new ArgvSplitError(
      `unterminated ${inSingle ? 'single' : 'double'} quote in command: ${input}`,
    );
  }

  if (hasContent) tokens.push(current);
  return tokens;
}
