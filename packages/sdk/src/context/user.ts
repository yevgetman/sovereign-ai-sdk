// User/project context discovery. Global context is loaded first, then local
// files are applied from repository root toward the current directory so the
// most-specific instructions appear last.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readBoundedUtf8 } from './boundedRead.js';
import { blockPlaceholder, screenContextFile } from './injectionDefense.js';

const CONTEXT_FILENAMES = ['AGENTS.md', 'CONTEXT.md', '.cursorrules'] as const;

export type UserContextOptions = {
  cwd?: string;
  homeDir?: string;
  warn?: (message: string) => void;
};

export type UserContextFile = {
  path: string;
  displayPath: string;
  text: string;
  blocked: boolean;
};

export type UserContext = {
  files: UserContextFile[];
};

export function getUserContext(options: UserContextOptions = {}): UserContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeDir = options.homeDir ?? homedir();
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  const files: UserContextFile[] = [];

  const globalPath = join(homeDir, '.harness', 'CONTEXT.md');
  if (existsSync(globalPath)) {
    files.push(readScreenedFile(globalPath, displayPath(globalPath, homeDir), warn));
  }

  for (const dir of dirsFromRootToCwd(cwd)) {
    for (const filename of CONTEXT_FILENAMES) {
      const path = join(dir, filename);
      if (existsSync(path)) {
        files.push(readScreenedFile(path, displayPath(path, homeDir), warn));
      }
    }
  }

  return { files };
}

export function formatUserContext(context: UserContext): string {
  if (context.files.length === 0) return '';
  return [
    '<user-context>',
    ...context.files.map((file) =>
      [
        `<context-file path="${escapeAttr(file.displayPath)}"${file.blocked ? ' blocked="true"' : ''}>`,
        file.text.trim(),
        '</context-file>',
      ].join('\n'),
    ),
    '</user-context>',
  ].join('\n');
}

function readScreenedFile(
  path: string,
  display: string,
  warn: (message: string) => void,
): UserContextFile {
  let raw = '';
  try {
    // Bounded read: cap allocation so a multi-GB context file can't OOM the
    // turn before screenContextFile truncates it (mirrors references.ts).
    raw = readBoundedUtf8(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { path, displayPath: display, text: blockPlaceholder(display, reason), blocked: true };
  }

  const screened = screenContextFile(display, raw);
  if (!screened.ok) {
    warn(`[WARN] blocked context file ${display}: ${screened.reason}`);
    return {
      path,
      displayPath: display,
      text: blockPlaceholder(display, screened.reason),
      blocked: true,
    };
  }

  if (screened.truncated) {
    warn(`[WARN] truncated context file ${display}: size > 20000 chars`);
  }
  return { path, displayPath: display, text: screened.text, blocked: false };
}

function dirsFromRootToCwd(cwd: string): string[] {
  const dirs: string[] = [];
  let cur = cwd;
  for (;;) {
    dirs.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs.reverse();
}

function displayPath(path: string, homeDir: string): string {
  return path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : path;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
