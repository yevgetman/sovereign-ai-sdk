// Redacted JSONL transcript writer for manual REPL test sessions.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

/**
 * Resolve the transcript path for a session, applying debug-mode defaults.
 * If `cliPath` is set it wins. Otherwise, when `debugMode.transcript` is
 * true — or when the umbrella `debugMode.enabled` is true — returns a
 * timestamped path under `transcriptDir` (default: `<harnessHome>/debug`).
 */
export function resolveDebugTranscriptPath(opts: {
  cliPath?: string | undefined;
  debugMode?:
    | {
        enabled?: boolean | undefined;
        transcript?: boolean | undefined;
        transcriptDir?: string | undefined;
      }
    | undefined;
  harnessHome: string;
  now?: () => Date;
}): string | undefined {
  if (opts.cliPath !== undefined) return opts.cliPath;
  const debug = opts.debugMode;
  const transcriptOn = debug?.transcript === true || debug?.enabled === true;
  if (!transcriptOn) return undefined;
  const dir = debug?.transcriptDir ?? join(opts.harnessHome, 'debug');
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
  return join(dir, `transcript-${stamp}.jsonl`);
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
