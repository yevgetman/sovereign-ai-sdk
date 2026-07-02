// Permission prompt utilities — askUser serializer + tool-input preview.
//
// After M13 dropped the readline REPL surface, the readline-based asker is
// gone; the surviving exports are consumed by canUseTool.ts.

import type { AskUser } from './types.js';

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
 * server's inline hint but kept separate to avoid cross-module coupling; if
 * a third caller appears, graduate to src/tool/preview.ts. */
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
