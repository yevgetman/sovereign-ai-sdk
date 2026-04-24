// Readline-backed asker. The REPL owns the readline instance and passes it
// in — we don't open a second readline, which would fight with the REPL's
// input loop. The parser (answer string → AskResponse) is factored out so
// the test suite can exercise it without spinning up readline.

import type { Interface as ReadlineInterface } from 'node:readline/promises';
import chalk from 'chalk';
import type { AskResponse, AskUser } from './types.js';

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
export function buildReadlineAsker(rl: ReadlineInterface): AskUser {
  return async ({ toolName, preview, reason, signal }) => {
    const summary = preview ? ` ${chalk.bold(preview)}` : '';
    const reasonLine = reason ? chalk.gray(` — ${reason}`) : '';
    process.stdout.write(chalk.yellow(`\n[permission] ${toolName}${summary}${reasonLine}\n`));
    for (;;) {
      const prompt = chalk.yellow('  allow? [y]es / [N]o / [a]lways: ');
      const raw = signal ? await rl.question(prompt, { signal }) : await rl.question(prompt);
      const parsed = parseAskResponse(raw);
      if (parsed !== undefined) return parsed;
      process.stdout.write(chalk.red('  please enter y, n, or a\n'));
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
