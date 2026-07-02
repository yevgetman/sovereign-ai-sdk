// Task 2.3 — the standing Bun-residual guard (the audit's regression gate).
//
// The Phase-2 shims (spawn → node:child_process, Bun.Glob → picomatch/tinyglobby,
// Bun.serve/Bun.file → node:http) removed every Bun global from the OPEN file
// set. This test keeps it that way: it recomputes the open set from the same
// manifest the boundary lint consumes (scripts/boundary-manifest.json, see
// .dependency-cruiser.cjs) and fails with file:line for any `Bun.` usage or
// `bun:`/`'bun'` import that creeps back into open-core source.
//
// Comment content is exempt (doc-comments legitimately reference Bun for parity
// notes — sessionPort.ts, argvSplit.ts, pathLock.ts, executorPort.ts, spawn.ts,
// writeScope.ts). The stripper is STRING-AWARE because open files carry
// comment-like sequences inside string literals (GlobTool's "src/**/*.ts",
// WebFetchTool's archive URL): a naive `//` / `/* */` strip would either blank
// real code after a glob string or hide a hit behind a URL. Known limitation:
// regex literals are not lexed (division ambiguity), so a regex containing `//`
// could over-strip the rest of its line — no such collision exists today and
// the failure mode is a single line, not runaway state.

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import manifest from '../../scripts/boundary-manifest.json';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');

/** src/protocol/ moved to the extracted package (Task 1.x); its manifest
 *  pattern is retained for history, so the package dir is scanned directly. */
const PROTOCOL_PACKAGE_DIR = 'packages/protocol/src';

const SOURCE_FILE_PATTERN = /\.tsx?$/;

/** Forbidden in open-core SOURCE positions (comments exempt). */
const FORBIDDEN_TOKEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'Bun global', pattern: /\bBun\./ },
  { name: 'bun import', pattern: /from\s+['"]bun[:'"]/ },
];

/** OPEN = the same union .dependency-cruiser.cjs compiles into its `from` set. */
const OPEN_PATTERNS: readonly RegExp[] = [
  ...manifest.openFullyDirs,
  ...manifest.openSplitDirFiles,
  ...manifest.openFilesInProprietaryDirs,
  ...manifest.openRootFiles,
].map((pattern) => new RegExp(pattern));

function gitLsFiles(pathspec: string): string[] {
  const stdout = execFileSync('git', ['ls-files', pathspec], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return stdout.split('\n').filter((line) => line.length > 0);
}

function listProtocolPackageFiles(): string[] {
  const entries = readdirSync(join(REPO_ROOT, PROTOCOL_PACKAGE_DIR), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((absolute) => absolute.slice(REPO_ROOT.length + 1));
}

function collectOpenFiles(): string[] {
  const openSrc = gitLsFiles('src').filter(
    (file) => SOURCE_FILE_PATTERN.test(file) && OPEN_PATTERNS.some((re) => re.test(file)),
  );
  const protocolPkg = listProtocolPackageFiles().filter((file) => SOURCE_FILE_PATTERN.test(file));
  return [...openSrc, ...protocolPkg].sort();
}

type LexState = 'code' | 'lineComment' | 'blockComment' | 'single' | 'double' | 'template';

/** Blank comment CONTENT to spaces (newlines preserved) so per-line matching
 *  sees only code + string positions. Tracks ', ", ` (with \ escapes) so
 *  comment openers inside string literals are ignored, and tracks template
 *  `${ … }` interpolations (brace-depth stack) so code inside them is scanned. */
function blankComments(source: string): string {
  const out: string[] = [];
  let state: LexState = 'code';
  const templateBraceDepths: number[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const pair = source.slice(index, index + 2);
    switch (state) {
      case 'code': {
        if (pair === '//') {
          state = 'lineComment';
          out.push('  ');
          index += 2;
        } else if (pair === '/*') {
          state = 'blockComment';
          out.push('  ');
          index += 2;
        } else {
          if (char === "'") state = 'single';
          else if (char === '"') state = 'double';
          else if (char === '`') state = 'template';
          else if ((char === '{' || char === '}') && templateBraceDepths.length > 0) {
            const top = templateBraceDepths.length - 1;
            const depth = templateBraceDepths[top] as number;
            if (char === '{') {
              templateBraceDepths[top] = depth + 1;
            } else if (depth === 0) {
              templateBraceDepths.pop();
              state = 'template';
            } else {
              templateBraceDepths[top] = depth - 1;
            }
          }
          out.push(char);
          index += 1;
        }
        break;
      }
      case 'lineComment': {
        if (char === '\n') {
          state = 'code';
          out.push('\n');
        } else {
          out.push(' ');
        }
        index += 1;
        break;
      }
      case 'blockComment': {
        if (pair === '*/') {
          state = 'code';
          out.push('  ');
          index += 2;
        } else {
          out.push(char === '\n' ? '\n' : ' ');
          index += 1;
        }
        break;
      }
      case 'single':
      case 'double': {
        const quote = state === 'single' ? "'" : '"';
        if (char === '\\') {
          out.push(source.slice(index, index + 2));
          index += 2;
        } else {
          if (char === quote || char === '\n') state = 'code';
          out.push(char);
          index += 1;
        }
        break;
      }
      case 'template': {
        if (char === '\\') {
          out.push(source.slice(index, index + 2));
          index += 2;
        } else if (pair === '${') {
          templateBraceDepths.push(0);
          state = 'code';
          out.push(pair);
          index += 2;
        } else {
          if (char === '`') state = 'code';
          out.push(char);
          index += 1;
        }
        break;
      }
    }
  }
  return out.join('');
}

function findForbiddenHits(file: string): string[] {
  const source = readFileSync(join(REPO_ROOT, file), 'utf8');
  const lines = blankComments(source).split('\n');
  const hits: string[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    for (const { name, pattern } of FORBIDDEN_TOKEN_PATTERNS) {
      if (pattern.test(line)) {
        hits.push(`${file}:${lineIndex + 1} [${name}] ${line.trim()}`);
      }
    }
  }
  return hits;
}

describe('Bun-residual guard — the open file set stays Bun-global-free', () => {
  const openFiles = collectOpenFiles();

  test('the open set is populated (the guard cannot silently scan nothing)', () => {
    expect(openFiles.length).toBeGreaterThan(50);
    expect(openFiles).toContain('src/tools/StaticSiteValidateTool.ts');
    expect(openFiles).toContain('src/util/spawn.ts');
    expect(openFiles).toContain('packages/protocol/src/index.ts');
    // Proprietary carve-outs must stay OUT of the scanned set.
    expect(openFiles).not.toContain('src/runtime/subprocessExecutor.ts');
    expect(openFiles).not.toContain('src/agent/sessionDb.ts');
  });

  test('the comment stripper blanks comments but not code or glob strings', () => {
    // Comment content is blanked…
    expect(blankComments('// Bun.serve parity note')).not.toMatch(/Bun\./);
    expect(blankComments('/* Bun.file */ keep()')).toContain('keep()');
    // …code positions survive…
    expect(blankComments('const s = Bun.serve({});')).toMatch(/\bBun\./);
    // …a glob string with `/*` must NOT open runaway block-comment state…
    expect(blankComments('const g = "src/**/*.ts";\nBun.file(g);')).toMatch(/\bBun\./);
    // …a URL's `//` must NOT hide code after it on the same line…
    expect(blankComments("fetch('http://x'); Bun.serve()")).toMatch(/\bBun\./);
    // …and code inside template interpolation is still scanned.
    expect(blankComments('const t = `v ${Bun.version}`;')).toMatch(/\bBun\./);
  });

  test('no open file uses a Bun global or bun: import in a code position', () => {
    const hits = openFiles.flatMap(findForbiddenHits);
    expect(hits).toEqual([]);
  });
});
