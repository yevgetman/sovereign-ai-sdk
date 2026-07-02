// StaticSiteValidateTool — read-only validation for simple static websites.
// Catches missing local HTML references, JavaScript syntax errors, and
// whether the entry page is servable without making the model shell out.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { buildTool } from '../tool/buildTool.js';
import { SPAWN_FAILURE_EXIT_CODE, spawnProc } from '../util/spawn.js';
import { resolveToolPath } from './pathUtils.js';
import { matchesPathPermissionPattern } from './permissionMatchers.js';

const inputSchema = z.object({
  path: z
    .string()
    .optional()
    .describe('Static site directory to validate. Accepts absolute, ~/, or cwd-relative paths.'),
  entry: z.string().optional().describe('Entry HTML file relative to path. Default: index.html.'),
  check_javascript: z
    .boolean()
    .optional()
    .describe('Run node --check on referenced local JavaScript files when Node is available.'),
});

type Input = z.infer<typeof inputSchema>;

type Check = {
  name: string;
  ok: boolean;
  details: string;
};

type Output = {
  ok: boolean;
  root: string;
  entry: string;
  checks: Check[];
};

export const StaticSiteValidateTool = buildTool<Input, Output>({
  name: 'StaticSiteValidate',
  description: () =>
    'Validate a static website directory: entry HTML exists, local href/src references exist, referenced JavaScript parses, and the entry page can be served.',
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: async () => ({ behavior: 'allow' }),
  preparePermissionMatcher: async (input) => (pattern) =>
    matchesPathPermissionPattern(input.path ?? '.', pattern),
  renderResult: (out) => ({
    content: [
      `${out.ok ? 'ok' : 'failed'}: ${out.root}/${out.entry}`,
      ...out.checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.details}`),
    ].join('\n'),
    ...(out.ok ? {} : { isError: true }),
  }),
  renderHint: { kind: 'tree' },
  async call(input, ctx) {
    const root = input.path ? resolveToolPath(input.path, ctx.cwd) : ctx.cwd;
    const entry = input.entry ?? 'index.html';
    const checks = await validateStaticSite(root, entry, input.check_javascript !== false);
    return {
      data: {
        ok: checks.every((check) => check.ok),
        root,
        entry,
        checks,
      },
    };
  },
});

export async function validateStaticSite(
  root: string,
  entry = 'index.html',
  checkJavascript = true,
): Promise<Check[]> {
  const checks: Check[] = [];
  const absRoot = resolve(root);
  const entryPath = resolveUnder(absRoot, entry);

  const rootCheck = directoryCheck(absRoot);
  checks.push(rootCheck);
  if (!rootCheck.ok) return checks;

  const entryCheck = fileCheck(entryPath, `entry exists: ${entry}`);
  checks.push(entryCheck);
  if (!entryCheck.ok) return checks;

  const html = readFileSync(entryPath, 'utf8');
  const refs = extractHtmlReferences(html);
  const localRefs = refs
    .map((ref) => resolveLocalReference(ref, dirname(entryPath), absRoot))
    .filter((ref): ref is LocalReference => ref !== null);

  const missing = localRefs.filter((ref) => !existsSync(ref.path));
  checks.push({
    name: 'local references exist',
    ok: missing.length === 0,
    details:
      missing.length === 0
        ? `${localRefs.length} local reference${localRefs.length === 1 ? '' : 's'} checked`
        : `missing: ${missing.map((ref) => ref.raw).join(', ')}`,
  });

  if (checkJavascript) {
    checks.push(await javascriptCheck(localRefs));
  }

  checks.push(await serverCheck(absRoot, entry));
  return checks;
}

type LocalReference = {
  raw: string;
  path: string;
};

function directoryCheck(path: string): Check {
  if (!existsSync(path)) return { name: 'site directory exists', ok: false, details: path };
  return statSync(path).isDirectory()
    ? { name: 'site directory exists', ok: true, details: path }
    : { name: 'site directory exists', ok: false, details: `${path} is not a directory` };
}

function fileCheck(path: string, name: string): Check {
  if (!existsSync(path)) return { name, ok: false, details: `missing ${path}` };
  return statSync(path).isFile()
    ? { name, ok: true, details: path }
    : { name, ok: false, details: `${path} is not a file` };
}

function extractHtmlReferences(html: string): string[] {
  const refs: string[] = [];
  const pattern = /\b(?:href|src)=["']([^"']+)["']/g;
  for (const match of html.matchAll(pattern)) {
    if (match[1]) refs.push(match[1]);
  }
  return refs;
}

function resolveLocalReference(raw: string, htmlDir: string, root: string): LocalReference | null {
  const normalized = normalizeLocalReference(raw);
  if (normalized === null) return null;
  const target = normalized.startsWith('/')
    ? resolveUnder(root, normalized.slice(1))
    : resolve(htmlDir, normalized);
  if (!isInside(root, target)) {
    return { raw, path: target };
  }
  return { raw, path: target };
}

function normalizeLocalReference(ref: string): string | null {
  const trimmed = ref.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith('#') ||
    /^(https?:|mailto:|tel:|data:|javascript:)/i.test(trimmed)
  ) {
    return null;
  }
  const withoutFragment = trimmed.split('#', 1)[0] ?? trimmed;
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment;
  return withoutQuery.length > 0 ? withoutQuery : null;
}

async function javascriptCheck(refs: LocalReference[]): Promise<Check> {
  const jsRefs = refs.filter(
    (ref) => extname(ref.path).toLowerCase() === '.js' && existsSync(ref.path),
  );
  if (jsRefs.length === 0) {
    return { name: 'referenced JavaScript parses', ok: true, details: 'no local JS references' };
  }
  const failures: string[] = [];
  for (const ref of jsRefs) {
    const result = await runNodeCheck(ref.path);
    if (!result.ok) failures.push(`${ref.raw}: ${result.details}`);
  }
  return {
    name: 'referenced JavaScript parses',
    ok: failures.length === 0,
    details: failures.length === 0 ? `${jsRefs.length} JS file(s) checked` : failures.join('\n'),
  };
}

async function runNodeCheck(path: string): Promise<{ ok: boolean; details: string }> {
  try {
    const proc = spawnProc(['node', '--check', path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ]);
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    // A missing node binary surfaces as the shim's spawn-failure exit code
    // (node:child_process reports spawn failures asynchronously, so the catch
    // below no longer sees them) — keep the "unavailable" wording.
    if (exitCode === SPAWN_FAILURE_EXIT_CODE && output.length === 0) {
      return { ok: false, details: 'node --check unavailable: command not found' };
    }
    return { ok: exitCode === 0, details: exitCode === 0 ? 'node --check passed' : output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, details: `node --check unavailable: ${message}` };
  }
}

// Loopback host for the ephemeral validation server (was Bun.serve; the
// node:http port pins an explicit loopback bind instead of Bun's 0.0.0.0
// default — same reachability for the local probe, no external exposure).
const SERVER_CHECK_HOST = '127.0.0.1';

async function serverCheck(root: string, entry: string): Promise<Check> {
  const server = createServer((req, res) => {
    try {
      // node:http's req.url is path+query only (Bun's fetch handler got an
      // absolute URL); the base host is irrelevant — only pathname is read.
      const url = new URL(req.url ?? '/', `http://${SERVER_CHECK_HOST}`);
      const requested = decodeURIComponent(
        url.pathname === '/' ? entry : url.pathname.replace(/^\/+/, ''),
      );
      const target = resolveUnder(root, requested);
      if (!isInside(root, target)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      if (!existsSync(target)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const stream = createReadStream(target);
      stream.on('error', () => {
        // Unreadable target (e.g. a directory): 500 if the implicit 200 has
        // not gone out yet, otherwise abort so the client sees a failure.
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(500);
          res.end();
        }
      });
      stream.pipe(res);
    } catch {
      // Mirrors Bun.serve's behavior of turning a thrown fetch handler (e.g.
      // decodeURIComponent on a malformed escape) into a 500 instead of
      // crashing the process.
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  const port = await listenOnEphemeralPort(server);
  try {
    const response = await fetch(`http://${SERVER_CHECK_HOST}:${port}/`);
    // Drain the body so no in-flight socket outlives the check.
    await response.arrayBuffer().catch(() => undefined);
    return {
      name: 'local server returns 200',
      ok: response.status === 200,
      details: `GET / returned ${response.status}`,
    };
  } finally {
    await closeServer(server);
  }
}

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(0, SERVER_CHECK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectPort(new Error(`server.address() returned non-TCP address: ${String(address)}`));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolveClose) => {
    // close() waits for open sockets; destroying them first keeps teardown
    // deterministic — the node:http equivalent of Bun's server.stop(true).
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function resolveUnder(root: string, child: string): string {
  return resolve(root, child.replace(/^\/+/, ''));
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
