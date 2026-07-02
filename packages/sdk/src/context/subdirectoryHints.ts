// Per-session subdirectory hints. When tools touch a new directory, nearby
// AGENTS.md / CONTEXT.md / .cursorrules files are appended to that tool
// result, not to the frozen system prompt.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { blockPlaceholder, screenContextFile } from './injectionDefense.js';

const HINT_FILES = ['AGENTS.md', 'CONTEXT.md', '.cursorrules'] as const;
const MAX_ANCESTOR_WALK = 5;

export type SubdirectoryHintState = {
  touched: Set<string>;
};

export function createSubdirectoryHintState(): SubdirectoryHintState {
  return { touched: new Set() };
}

export function appendSubdirectoryHints(opts: {
  toolName: string;
  input: unknown;
  content: string;
  cwd: string;
  state: SubdirectoryHintState;
}): string {
  const target = resolveTouchedDirectory(opts.toolName, opts.input, opts.cwd);
  if (!target || opts.state.touched.has(target)) return opts.content;
  opts.state.touched.add(target);
  const hints = collectHints(target);
  if (hints.length === 0) return opts.content;
  return `${opts.content}\n\n[subdirectory hints loaded]\n${hints.join('\n\n')}`;
}

export function collectHints(targetDir: string): string[] {
  const dirs: string[] = [];
  let cur = targetDir;
  for (let i = 0; i < MAX_ANCESTOR_WALK; i++) {
    dirs.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  dirs.reverse();

  const hints: string[] = [];
  for (const dir of dirs) {
    for (const filename of HINT_FILES) {
      const path = join(dir, filename);
      if (!existsSync(path) || !lstatSync(path).isFile()) continue;
      const raw = readFileSync(path, 'utf8');
      const screened = screenContextFile(path, raw);
      const body = screened.ok ? screened.text.trim() : blockPlaceholder(path, screened.reason);
      hints.push(`<hint-file path="${escapeAttr(path)}">\n${body}\n</hint-file>`);
    }
  }
  return hints;
}

function resolveTouchedDirectory(toolName: string, input: unknown, cwd: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (
    toolName === 'FileRead' ||
    toolName === 'FileWrite' ||
    toolName === 'FileEdit' ||
    toolName === 'Grep' ||
    toolName === 'Glob'
  ) {
    const rawPath = typeof obj.path === 'string' ? obj.path : '.';
    const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    if (existsSync(abs) && lstatSync(abs).isDirectory()) return abs;
    return dirname(abs);
  }
  if (toolName === 'Bash' && typeof obj.command === 'string') {
    const cd = obj.command.match(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/);
    if (!cd) return null;
    const raw = (cd[1] ?? '').replace(/^['"]|['"]$/g, '');
    return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  }
  return null;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
