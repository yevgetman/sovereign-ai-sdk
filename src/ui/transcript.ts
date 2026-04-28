// Redacted JSONL transcript writer for manual REPL test sessions.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { expandHomePath } from '../tools/pathUtils.js';

export type TranscriptEvent = {
  type: string;
  [key: string]: unknown;
};

export type TranscriptLogger = {
  path: string;
  record: (event: TranscriptEvent) => void;
};

export function createTranscriptLogger(
  path: string | undefined,
  opts: { cwd?: string; now?: () => Date } = {},
): TranscriptLogger | null {
  if (!path) return null;
  const resolvedPath = resolveTranscriptPath(path, opts.cwd ?? process.cwd());
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, '');

  return {
    path: resolvedPath,
    record: (event) => {
      const stamped = redactValue({
        timestamp: (opts.now ?? (() => new Date()))().toISOString(),
        ...event,
      });
      appendFileSync(resolvedPath, `${JSON.stringify(stamped)}\n`);
    },
  };
}

export function redactTranscriptText(input: string): string {
  return input
    .replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, 'sk-ant-[REDACTED]')
    .replace(/\bsk-or-[A-Za-z0-9_-]+\b/g, 'sk-or-[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]')
    .replace(/\b((?:ANTHROPIC|OPENAI|OPENROUTER)_API_KEY=)[^\s]+/g, '$1[REDACTED]')
    .replace(/\b(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}

function resolveTranscriptPath(path: string, cwd: string): string {
  const expanded = expandHomePath(path);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactTranscriptText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactValue(nested);
    }
    return out;
  }
  return value;
}
