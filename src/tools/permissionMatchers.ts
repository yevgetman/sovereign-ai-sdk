import { basename } from 'node:path';
import { wildcardMatches } from '../config/rules.js';

export function matchesPathPermissionPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  const candidates = new Set<string>([
    normalizedPath,
    stripDotSlash(normalizedPath),
    basename(normalizedPath),
  ]);
  return Array.from(candidates).some((candidate) =>
    wildcardMatches(normalizedPattern, candidate, { flavor: 'file' }),
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function stripDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}
