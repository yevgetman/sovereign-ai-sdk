// Shared filesystem path normalization for native tools.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function expandHomePath(path: string, homeDir = homedir()): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/')) return join(homeDir, path.slice(2));
  return path;
}

export function resolveToolPath(path: string, cwd: string): string {
  const expanded = expandHomePath(path);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
