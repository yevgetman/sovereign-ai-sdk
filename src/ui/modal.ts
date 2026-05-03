// Modal overlay primitive. Renders a framed prompt that survives
// concurrent decorator output (the thinking spinner, the compact tool
// slot) by raising a module-level `modalActive` flag that those
// decorators consult before writing. The actual answer is read through
// the same readline `question()` the REPL already owns — we don't open
// a second readline, we just give it a richer-looking prompt.
//
// One modal is active at a time (caller-enforced via serializeAskUser).
// Nested withModal calls throw — that would suggest a bug in the
// permission flow, not a recoverable state.

import { boxify } from './box.js';
import { theme } from './theme.js';

let modalActive = false;

/** Decorators (ThinkingIndicator, animated tool slots) call this before
 *  writing to stdout and skip their tick when a modal is up. Keeps the
 *  spinner from clobbering a permission prompt that's awaiting input. */
export function isModalActive(): boolean {
  return modalActive;
}

interface WritableLike {
  write(chunk: string): boolean;
}

type ReadlineQuestion = (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;

export type ModalRow = {
  /** Short label rendered dim, e.g. "tool", "input", "reason". */
  label: string;
  /** Value rendered with default styling. */
  value: string;
};

export type ModalChoice = {
  /** Single-character key the user types. Case-insensitive. */
  key: string;
  /** Short description rendered next to the key. */
  label: string;
  /** When true, this choice is the highlighted default. Optional. */
  default?: boolean;
};

export type WithModalOpts<T> = {
  /** Title rendered as the first line inside the frame. */
  title: string;
  /** Body rows. Rendered as `<dim label>  <value>`. */
  rows: ModalRow[];
  /** Choices rendered as `[k] label   [k] label   ...`. */
  choices: ModalChoice[];
  /** Parse the user's response. Return undefined to re-prompt. */
  parse: (raw: string) => T | undefined;
  /** Readline question() — REPL passes its serialized one in. */
  question: ReadlineQuestion;
  /** Stream to write the frame to. Defaults to stdout. */
  out?: WritableLike;
  /** Border accent color. Defaults to yellow (matches existing
   *  permission styling). */
  borderColor?: (s: string) => string;
  /** Optional abort signal forwarded to readline question(). */
  signal?: AbortSignal;
  /** Message shown after a parse failure before re-prompting. */
  reprompt?: string;
};

/**
 * Render a framed modal, read the answer, return parsed result. Holds
 * the modal-active flag for the duration so concurrent decorators
 * suppress themselves. Re-prompts on parse failure with the configured
 * `reprompt` message.
 */
export async function withModal<T>(opts: WithModalOpts<T>): Promise<T> {
  if (modalActive) {
    throw new Error('withModal: a modal is already active');
  }
  modalActive = true;
  const out = opts.out ?? process.stdout;
  const borderColor = opts.borderColor ?? theme.tokens.borderWarning;
  try {
    const lines = renderFrame(opts.title, opts.rows, opts.choices, borderColor);
    out.write(`\n${lines.join('\n')}\n`);
    const reprompt = opts.reprompt ?? 'unrecognised — please try again';
    for (;;) {
      const promptText = theme.tokens.statusWarning('  > ');
      const raw = opts.signal
        ? await opts.question(promptText, { signal: opts.signal })
        : await opts.question(promptText);
      const parsed = opts.parse(raw);
      if (parsed !== undefined) return parsed;
      out.write(theme.tokens.statusError(`  ${reprompt}\n`));
    }
  } finally {
    modalActive = false;
  }
}

/** Render the box body (title + rows + choices) as an array of styled
 *  lines that boxify wraps with a frame. Exported for tests. */
export function renderFrame(
  title: string,
  rows: ModalRow[],
  choices: ModalChoice[],
  borderColor: (s: string) => string,
): string[] {
  const t = theme.tokens;
  const labelWidth = rows.reduce((max, r) => Math.max(max, r.label.length), 0);
  const body: string[] = [];
  body.push(t.textBold(t.statusWarning(title)));
  if (rows.length > 0) body.push('');
  for (const row of rows) {
    const padded = row.label.padEnd(labelWidth, ' ');
    body.push(`${t.textMuted(padded)}  ${row.value}`);
  }
  if (choices.length > 0) {
    body.push('');
    body.push(formatChoices(choices));
  }
  return boxify(body, { padding: 2, borderColor });
}

function formatChoices(choices: ModalChoice[]): string {
  const t = theme.tokens;
  return choices
    .map((c) => {
      const keyText = c.default ? `[${c.key.toUpperCase()}]` : `[${c.key}]`;
      const key = c.default ? t.textBold(t.statusWarning(keyText)) : t.statusWarning(keyText);
      return `${key} ${t.textMuted(c.label)}`;
    })
    .join('   ');
}
