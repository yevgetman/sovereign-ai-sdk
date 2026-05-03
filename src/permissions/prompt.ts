// Readline-backed asker. The REPL owns the readline instance and passes it
// in — we don't open a second readline, which would fight with the REPL's
// input loop. The parser (answer string → AskResponse) is factored out so
// the test suite can exercise it without spinning up readline.
//
// Phase 10.5b: the prompt is rendered as a framed modal (see ui/modal.ts)
// so it can't get visually buried by the thinking spinner or other
// concurrent decorators. The readline question() still reads the answer,
// so existing tests that drive a stub question fn keep working.

import type { Interface as ReadlineInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { type ModalRow, withModal } from '../ui/modal.js';
import type { AskResponse, AskUser } from './types.js';

type ReadlineQuestion = (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;

export type ReadlineAskerHooks = {
  onPrompt?: (event: { toolName: string; preview: string; reason?: string }) => void;
  onAnswer?: (event: {
    toolName: string;
    preview: string;
    reason?: string;
    answer: AskResponse;
  }) => void;
};

/**
 * Parse a human-typed answer into a structured response. Undefined for
 * un-recognised input — callers re-prompt in that case.
 */
export function parseAskResponse(raw: string): AskResponse | undefined {
  const answer = raw.trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return 'allow';
  if (answer === 'n' || answer === 'no' || answer === '') return 'deny';
  if (answer === 'a' || answer === 'always') return 'always';
  return undefined;
}

/**
 * Build an AskUser that reads from the given readline. Empty line defaults
 * to deny (safer default — the user hit enter without thinking).
 */
export function buildReadlineAsker(
  rl: ReadlineInterface | ReadlineQuestion,
  hooks: ReadlineAskerHooks = {},
): AskUser {
  const question: ReadlineQuestion =
    typeof rl === 'function'
      ? rl
      : (prompt, options) =>
          options?.signal ? rl.question(prompt, { signal: options.signal }) : rl.question(prompt);
  return serializeAskUser(async ({ toolName, preview, reason, signal }) => {
    const event = {
      toolName,
      preview,
      ...(reason ? { reason } : {}),
    };
    hooks.onPrompt?.(event);
    const rows: ModalRow[] = [{ label: 'tool', value: chalk.bold(toolName) }];
    if (preview) rows.push({ label: 'input', value: preview });
    if (reason) rows.push({ label: 'reason', value: chalk.gray(reason) });
    const answer = await withModal<AskResponse>({
      title: 'permission required',
      rows,
      choices: [
        { key: 'y', label: 'allow' },
        { key: 'n', label: 'deny', default: true },
        { key: 'a', label: 'always' },
      ],
      parse: parseAskResponse,
      question,
      reprompt: 'please enter y, n, or a',
      ...(signal ? { signal } : {}),
    });
    hooks.onAnswer?.({ ...event, answer });
    return answer;
  });
}

/** Serialize interactive permission prompts so concurrent tool batches do
 * not print multiple readline questions at once. Tool execution can still
 * run concurrently after each permission decision resolves. */
export function serializeAskUser(ask: AskUser): AskUser {
  let tail: Promise<void> = Promise.resolve();
  return async (opts) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (opts.signal?.aborted) throw new Error('permission prompt aborted');
      return await ask(opts);
    } finally {
      release();
    }
  };
}

/** Truncated single-line preview of a tool_use input. Shared shape with the
 * REPL's inline hint but kept separate to avoid cross-module coupling; if a
 * third caller appears, graduate to src/tool/preview.ts. */
export function previewToolInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return truncate(input);
  if (typeof input !== 'object') return truncate(String(input));
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === 'string') return truncate(obj.command);
  try {
    return truncate(JSON.stringify(obj));
  } catch {
    return '';
  }
}

function truncate(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}
