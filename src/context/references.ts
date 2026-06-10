// @-reference expansion for user turns. References are resolved before the
// model call and substituted with fenced, bounded context blocks.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { type LookupImpl, assertResolvedHostPublic, checkUrlAllowed } from '../tools/ssrfGuard.js';
import { blockPlaceholder, screenContextFile } from './injectionDefense.js';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_URL_BYTES = 128 * 1024;
const MAX_FOLDER_ENTRIES = 500;

export type ReferenceOptions = {
  cwd?: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver for the @url SSRF guard (tests). */
  lookupImpl?: LookupImpl;
};

type Match =
  | { start: number; end: number; kind: 'file' | 'folder' | 'url'; value: string }
  | { start: number; end: number; kind: 'diff' | 'staged' };

export async function expandContextReferences(
  input: string,
  options: ReferenceOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const matches = findReferences(input);
  if (matches.length === 0) return input;

  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += input.slice(cursor, match.start);
    out += await resolveReference(match, { ...options, cwd });
    cursor = match.end;
  }
  out += input.slice(cursor);
  return out;
}

function findReferences(input: string): Match[] {
  const matches: Match[] = [];
  const re = /@(file|folder|url):(?:"([^"]+)"|(\S+))|@(diff|staged)\b/g;
  for (const m of input.matchAll(re)) {
    if (m.index === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (m[1] === 'file' || m[1] === 'folder' || m[1] === 'url') {
      matches.push({ start, end, kind: m[1], value: m[2] ?? m[3] ?? '' });
    } else if (m[4] === 'diff' || m[4] === 'staged') {
      matches.push({ start, end, kind: m[4] });
    }
  }
  return matches;
}

async function resolveReference(
  match: Match,
  options: Required<Pick<ReferenceOptions, 'cwd'>> & ReferenceOptions,
): Promise<string> {
  if (match.kind === 'file') return fileReference(match.value, options);
  if (match.kind === 'folder') return folderReference(match.value, options);
  if (match.kind === 'url') return urlReference(match.value, options);
  if (match.kind === 'diff') return gitReference(['diff', '--'], options.cwd, 'git diff');
  return gitReference(['diff', '--staged', '--'], options.cwd, 'git staged diff');
}

function fileReference(raw: string, options: ReferenceOptions & { cwd: string }): string {
  const parsed = parseFileRange(raw);
  const abs = resolveReferencePath(parsed.path, options);
  const blocked = sensitiveBlock(abs, options);
  if (blocked) return blocked;
  if (!existsSync(abs)) return `[ERROR: file not found ${abs}]`;
  // realpath/lstat/readFileSync can throw on EACCES (no read permission) or
  // ENOENT (deleted mid-read). Mirror urlReference/gitReference: inline an
  // [ERROR] marker rather than throwing — expandContextReferences must never
  // reject (an unhandled rejection in the turns route hangs the turn).
  try {
    if (lstatSync(abs).isDirectory()) return `[ERROR: path is a directory ${abs}]`;
    const real = realpathSync(abs);
    const stat = lstatSync(real);
    if (stat.size > MAX_FILE_BYTES) {
      return `[ERROR: file too large ${real} (${stat.size} bytes, cap ${MAX_FILE_BYTES})]`;
    }
    let text = readFileSync(real, 'utf8');
    if (parsed.range) {
      const lines = text.split('\n');
      text = lines.slice(parsed.range.start - 1, parsed.range.end).join('\n');
    }
    const screened = screenContextFile(real, text);
    if (!screened.ok) return blockPlaceholder(real, screened.reason);
    return fence(
      `referenced-file path="${escapeAttr(real)}"`,
      screened.text,
      languageForPath(real),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return `[ERROR: cannot read file ${abs}: ${msg}]`;
  }
}

function folderReference(raw: string, options: ReferenceOptions & { cwd: string }): string {
  const abs = resolveReferencePath(raw, options);
  const blocked = sensitiveBlock(abs, options);
  if (blocked) return blocked;
  if (!existsSync(abs)) return `[ERROR: folder not found ${abs}]`;
  try {
    const real = realpathSync(abs);
    if (!lstatSync(real).isDirectory()) return `[ERROR: path is not a directory ${real}]`;
    const entries = folderTree(real);
    return fence(`referenced-folder path="${escapeAttr(real)}"`, entries.join('\n'), 'text');
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return `[ERROR: cannot read folder ${abs}: ${msg}]`;
  }
}

async function urlReference(raw: string, options: ReferenceOptions): Promise<string> {
  if (!/^https?:\/\//i.test(raw)) return `[ERROR: unsupported URL ${raw}]`;
  // @url is expanded on the server for whatever turn text arrives — incl. an
  // authenticated gateway principal's. Apply the same SSRF gate as WebFetch:
  // refuse private/loopback/metadata hosts and re-validate every redirect hop
  // (audit 2026-06-10). DNS guard runs on the real-fetch path.
  const injectedFetch = options.fetchImpl;
  const fetchImpl = injectedFetch ?? fetch;
  const lookupImpl = options.lookupImpl;
  const dnsGuardEnabled = !injectedFetch || lookupImpl !== undefined;

  const guard = checkUrlAllowed(raw);
  if (!guard.ok) return `[ERROR: URL fetch refused ${raw}: ${guard.reason}]`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let currentUrl = raw;
    let response: Response;
    let redirects = 0;
    while (true) {
      if (dnsGuardEnabled) {
        const dnsBlock = await assertResolvedHostPublic(new URL(currentUrl).hostname, lookupImpl);
        if (dnsBlock) return `[ERROR: URL fetch refused ${raw}: ${dnsBlock}]`;
      }
      response = await fetchImpl(currentUrl, { signal: controller.signal, redirect: 'manual' });
      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get('location');
      if (!isRedirect || !location) break;
      if (redirects >= 5) return `[ERROR: URL fetch failed ${raw}: too many redirects]`;
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        return `[ERROR: URL fetch failed ${raw}: invalid redirect Location]`;
      }
      const hop = checkUrlAllowed(nextUrl);
      if (!hop.ok) return `[ERROR: URL fetch refused ${raw}: redirect ${hop.reason}]`;
      currentUrl = nextUrl;
      redirects += 1;
    }
    if (!response.ok) return `[ERROR: URL fetch failed ${raw} status=${response.status}]`;
    const text = (await response.text()).slice(0, MAX_URL_BYTES);
    return fence(`referenced-url url="${escapeAttr(raw)}"`, text, 'text');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[ERROR: URL fetch failed ${raw}: ${msg}]`;
  } finally {
    clearTimeout(timer);
  }
}

function gitReference(args: string[], cwd: string, label: string): string {
  try {
    const text = execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3_000 }).trimEnd();
    return fence(
      `referenced-${label.replace(/\s+/g, '-')} cwd="${escapeAttr(cwd)}"`,
      text || '(empty)',
      'diff',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return `[ERROR: ${label} unavailable: ${msg}]`;
  }
}

function parseFileRange(raw: string): { path: string; range?: { start: number; end: number } } {
  const match = raw.match(/^(.*):(\d+)-(\d+)$/);
  if (!match) return { path: raw };
  const start = Number.parseInt(match[2] ?? '', 10);
  const end = Number.parseInt(match[3] ?? '', 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) {
    return { path: raw };
  }
  return { path: match[1] ?? raw, range: { start, end } };
}

function resolveReferencePath(raw: string, options: ReferenceOptions & { cwd: string }): string {
  const homeDir = options.homeDir ?? homedir();
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homeDir, raw.slice(2)) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(options.cwd, expanded);
}

function sensitiveBlock(abs: string, options: ReferenceOptions): string | null {
  const homeDir = options.homeDir ?? homedir();
  // realpathSync can throw EACCES on an unreadable (chmod 000) path even though
  // existsSync is true; fall back to the lexically-resolved path so the
  // sensitive-name check still runs and we never throw out of here.
  const real = ((): string => {
    try {
      return existsSync(abs) ? realpathSync(abs) : resolve(abs);
    } catch {
      return resolve(abs);
    }
  })();
  const base = real.split('/').at(-1) ?? real;
  const relHome = real.startsWith(homeDir) ? relative(homeDir, real) : '';
  const sensitiveNames = new Set([
    'id_rsa',
    'id_rsa.pub',
    'authorized_keys',
    '.bashrc',
    '.zshrc',
    'sudoers',
  ]);
  if (real === '/etc/shadow' || real === '/etc/passwd') return `[BLOCKED: sensitive path ${real}]`;
  if (sensitiveNames.has(base)) return `[BLOCKED: sensitive path ${real}]`;
  if (/^(?:\.ssh|\.aws|\.gnupg|\.kube)(?:\/|$)/.test(relHome)) {
    return `[BLOCKED: sensitive path ${real}]`;
  }
  return null;
}

function folderTree(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0 && out.length < MAX_FOLDER_ENTRIES) {
    const rel = stack.shift() ?? '';
    const dir = join(root, rel);
    const entries = (() => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        // Unreadable (EACCES) or vanished (ENOENT) subdirectory.
        return null;
      }
    })();
    if (entries === null) {
      // Note it and keep walking the rest instead of aborting the whole listing.
      out.push(`${rel ? `${rel}/` : ''}[unreadable]`);
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FOLDER_ENTRIES) break;
      const childRel = join(rel, entry.name);
      out.push(`${childRel}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory()) stack.push(childRel);
    }
  }
  if (stack.length > 0) out.push('[truncated]');
  return out;
}

function fence(label: string, text: string, lang: string): string {
  return `<${label}>\n\`\`\`${lang}\n${text}\n\`\`\`\n</${label.split(' ')[0]}>`;
}

function languageForPath(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === 'ts' || ext === 'tsx') return 'ts';
  if (ext === 'js' || ext === 'jsx') return 'js';
  if (ext === 'md') return 'md';
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'py') return 'py';
  if (ext === 'sh') return 'bash';
  return 'text';
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
