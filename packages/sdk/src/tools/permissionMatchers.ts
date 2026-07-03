import { basename } from 'node:path';
import { wildcardMatches } from '../config/rules.js';
import { expandHomePath } from './pathUtils.js';

// On a case-INSENSITIVE filesystem (macOS APFS default, Windows NTFS) a path and
// its case variants resolve to the SAME file, so `~/.ssh/id_rsa` and
// `~/.ssh/ID_RSA` are one file. Matching path rules case-SENSITIVELY there let a
// `deny Read(~/.ssh/id_rsa)` rule be trivially bypassed by requesting the
// upper-cased spelling (and would likewise UNDER-match an allow). Derive the
// default from the platform — case-insensitive on darwin/win32, case-sensitive
// on Linux ext* — matching each platform's default filesystem behavior. This is
// a heuristic (a case-sensitive APFS volume or a case-insensitive Linux mount is
// the rare exception); callers/tests may override it explicitly.
const PLATFORM_PATHS_CASE_INSENSITIVE =
  typeof process !== 'undefined' && (process.platform === 'darwin' || process.platform === 'win32');

export function matchesPathPermissionPattern(
  path: string,
  pattern: string,
  opts: { caseInsensitive?: boolean } = {},
): boolean {
  const caseInsensitive = opts.caseInsensitive ?? PLATFORM_PATHS_CASE_INSENSITIVE;
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  const candidates = new Set<string>([
    normalizedPath,
    stripDotSlash(normalizedPath),
    basename(normalizedPath),
  ]);
  return Array.from(candidates).some((candidate) =>
    wildcardMatches(normalizedPattern, candidate, {
      flavor: 'file',
      caseSensitive: !caseInsensitive,
    }),
  );
}

function normalizePath(path: string): string {
  return expandHomePath(path).replace(/\\/g, '/');
}

function stripDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}
