import { describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  archivePathFor,
  compileBinaries,
  findBuilderLeak,
  packageStage,
  resolveTarget,
  shouldStageBundlePath,
  stagedBinaryPaths,
  unsafeCompileDirReason,
  validateBuildInputs,
} from '../../scripts/release-build-target';
import { TARGETS, type Target } from '../../scripts/release-shared';
import { collectZipEntries } from '../../scripts/release-zip';

function target(name: Target['name']): Target {
  const t = TARGETS.find((x) => x.name === name);
  if (!t) throw new Error(`no target ${name}`);
  return t;
}

describe('release-build-target — resolveTarget', () => {
  test('returns the target spec for a known name', () => {
    const t = resolveTarget('darwin-arm64');
    expect(t).not.toBeNull();
    if (t === null) throw new Error('unreachable');
    expect(t.name).toBe('darwin-arm64');
    expect(t.bunTarget).toBe('bun-darwin-arm64');
    expect(t.goos).toBe('darwin');
    expect(t.goarch).toBe('arm64');
  });

  test('resolves windows-x64 (Telekit for Windows)', () => {
    const t = resolveTarget('windows-x64');
    expect(t).toEqual({
      name: 'windows-x64',
      bunTarget: 'bun-windows-x64',
      goos: 'windows',
      goarch: 'amd64',
    });
  });

  test('returns null for an unknown target', () => {
    expect(resolveTarget('freebsd-x64')).toBeNull();
    expect(resolveTarget('')).toBeNull();
  });
});

describe('release-build-target — stagedBinaryPaths', () => {
  test('windows binaries are sov.exe + sov-tui.exe under bin/', () => {
    const bins = stagedBinaryPaths('/stage', target('windows-x64'));
    expect(bins.sov).toBe(join('/stage', 'bin', 'sov.exe'));
    expect(bins.tui).toBe(join('/stage', 'bin', 'sov-tui.exe'));
  });

  test('darwin + linux binaries stay extension-less', () => {
    for (const name of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const) {
      const bins = stagedBinaryPaths('/stage', target(name));
      expect(bins.sov).toBe(join('/stage', 'bin', 'sov'));
      expect(bins.tui).toBe(join('/stage', 'bin', 'sov-tui'));
    }
  });
});

describe('release-build-target — archivePathFor', () => {
  test('windows lands as sov-windows-x64.zip, others as .tar.gz', () => {
    expect(archivePathFor('/rel', target('windows-x64'))).toBe(join('/rel', 'sov-windows-x64.zip'));
    expect(archivePathFor('/rel', target('linux-x64'))).toBe(join('/rel', 'sov-linux-x64.tar.gz'));
    expect(archivePathFor('/rel', target('darwin-arm64'))).toBe(
      join('/rel', 'sov-darwin-arm64.tar.gz'),
    );
  });
});

describe('release-build-target — packageStage (windows zip)', () => {
  test('zips a staged tree with the tarball layout rooted at the archive top', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sov-pkg-win-'));
    try {
      const stage = join(tmp, 'windows-x64');
      mkdirSync(join(stage, 'bin'), { recursive: true });
      mkdirSync(join(stage, 'bundle-default', 'state'), { recursive: true });
      writeFileSync(join(stage, 'bin', 'sov.exe'), 'MZ-sov');
      writeFileSync(join(stage, 'bin', 'sov-tui.exe'), 'MZ-tui');
      writeFileSync(join(stage, 'bundle-default', 'index.yaml'), 'projectId: x\n');
      writeFileSync(join(stage, 'bundle-default', 'state', '.gitkeep'), '');
      writeFileSync(join(stage, 'version'), 'v0.7.0\n');
      writeFileSync(join(stage, 'LICENSE.txt'), 'beta');
      writeFileSync(join(stage, 'README.md'), 'readme');

      const archive = archivePathFor(tmp, target('windows-x64'));
      packageStage(target('windows-x64'), stage, archive);

      expect(existsSync(archive)).toBe(true);
      expect(archive.endsWith('sov-windows-x64.zip')).toBe(true);
      // Re-walk the stage through the same collector the zip used, and
      // confirm the archive's first local header names the first entry.
      const entries = collectZipEntries(stage).map((e) => e.path);
      expect(entries).toEqual([
        'LICENSE.txt',
        'README.md',
        'bin/sov-tui.exe',
        'bin/sov.exe',
        'bundle-default/index.yaml',
        'bundle-default/state/.gitkeep',
        'version',
      ]);
      const bytes = readFileSync(archive);
      expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
      const nameLen = bytes.readUInt16LE(26);
      expect(bytes.subarray(30, 30 + nameLen).toString('utf8')).toBe('LICENSE.txt');
      const compressedLen = bytes.readUInt32LE(18);
      const payload = bytes.subarray(30 + nameLen, 30 + nameLen + compressedLen);
      expect(Buffer.from(deflateRawSync('beta', { level: 9 })).equals(payload)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('release-build-target — validateBuildInputs', () => {
  test('returns ok when both target + version look valid and LICENSE.txt exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-build-valid-'));
    try {
      writeFileSync(join(dir, 'LICENSE.txt'), 'beta');
      const r = validateBuildInputs({
        target: 'darwin-arm64',
        version: 'v0.6.0',
        publicRepoPath: dir,
      });
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns error for an unknown target', () => {
    const r = validateBuildInputs({
      target: 'freebsd-x64',
      version: 'v0.6.0',
      publicRepoPath: '/some/path',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('unknown target');
  });

  test('returns error for a bad version format', () => {
    const r = validateBuildInputs({
      target: 'darwin-arm64',
      version: 'not-a-version',
      publicRepoPath: '/some/path',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('bad version');
  });

  test('returns error when publicRepoPath has no LICENSE.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sov-build-empty-'));
    try {
      const r = validateBuildInputs({
        target: 'darwin-arm64',
        version: 'v0.6.0',
        publicRepoPath: dir,
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain('LICENSE.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release-build-target — shouldStageBundlePath (audit C1: no state leak)', () => {
  const bundleRoot = '/repo/bundle-default';

  test('stages content outside state/', () => {
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/index.yaml')).toBe(true);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/agents/explore.md')).toBe(true);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/business/x.md')).toBe(true);
  });

  test('keeps the state/ dir shell and its tracked .gitkeep', () => {
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/state')).toBe(true);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/state/.gitkeep')).toBe(true);
  });

  test('DROPS captured runtime state (the leak vector)', () => {
    expect(
      shouldStageBundlePath(
        bundleRoot,
        '/repo/bundle-default/state/artifacts/trajectories/failed.jsonl',
      ),
    ).toBe(false);
    expect(
      shouldStageBundlePath(
        bundleRoot,
        '/repo/bundle-default/state/artifacts/trajectories/samples.jsonl',
      ),
    ).toBe(false);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/state/sessions.db')).toBe(false);
    expect(shouldStageBundlePath(bundleRoot, '/repo/bundle-default/state/secret.env')).toBe(false);
  });

  test('end-to-end: cpSync with the filter excludes state trajectories but keeps .gitkeep', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sov-stage-'));
    try {
      const src = join(tmp, 'bundle-default');
      mkdirSync(join(src, 'state', 'artifacts', 'trajectories'), { recursive: true });
      mkdirSync(join(src, 'agents'), { recursive: true });
      writeFileSync(join(src, 'index.yaml'), 'projectId: x\n');
      writeFileSync(join(src, 'agents', 'explore.md'), 'agent');
      writeFileSync(join(src, 'state', '.gitkeep'), '');
      writeFileSync(
        join(src, 'state', 'artifacts', 'trajectories', 'failed.jsonl'),
        'SECRET gho_xxx',
      );

      const dest = join(tmp, 'stage', 'bundle-default');
      cpSync(src, dest, { recursive: true, filter: (s) => shouldStageBundlePath(src, s) });

      expect(existsSync(join(dest, 'index.yaml'))).toBe(true);
      expect(existsSync(join(dest, 'agents', 'explore.md'))).toBe(true);
      expect(existsSync(join(dest, 'state', '.gitkeep'))).toBe(true);
      expect(existsSync(join(dest, 'state', 'artifacts', 'trajectories', 'failed.jsonl'))).toBe(
        false,
      );
      expect(existsSync(join(dest, 'state', 'artifacts'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('release-build-target — builder path leak scan', () => {
  test('rejects the current home prefix and the bytes ~/code', () => {
    expect(findBuilderLeak(Buffer.from('clean binary'), '/Users/example')).toBeNull();
    expect(findBuilderLeak(Buffer.from('x /Users/example/code/repo y'), '/Users/example')).toBe(
      '/Users/example',
    );
    expect(findBuilderLeak(Buffer.from('x /home/example/proj y'), '/home/example')).toBe(
      '/home/example',
    );
    expect(findBuilderLeak(Buffer.from('see ~/code/foo'), '/Users/example')).toBe('~/code');

    const home = homedir().replace(/[\\/]+$/, '');
    const marked = Buffer.from(`prefix ${home}/code suffix`);
    if (home === '/Users/runner' || home === '/home/runner') {
      expect(findBuilderLeak(marked, home)).toBeNull();
    } else {
      expect(findBuilderLeak(marked, home)).toBe(home);
    }
  });

  test('allows exactly the runner account, whose prefix Bun already embeds', () => {
    const webkit = Buffer.from('/Users/runner/work/_temp/webkit-release/JavaScriptCore');
    expect(findBuilderLeak(webkit, '/Users/runner')).toBeNull();
    expect(findBuilderLeak(Buffer.from('/home/runner/work/repo'), '/home/runner')).toBeNull();
    expect(findBuilderLeak(Buffer.from('~/code'), '/Users/runner')).toBe('~/code');
    // A different builder still fails if their own home is present, and the
    // runner prefix alone is not their home.
    expect(findBuilderLeak(webkit, '/Users/example')).toBeNull();
    expect(findBuilderLeak(Buffer.from('/Users/example/work'), '/Users/runner/')).toBeNull();
  });
});

describe('release-build-target — bun compile dir must be under /tmp', () => {
  test('rejects $HOME and /var/folders, accepts /tmp and /private/tmp', () => {
    expect(unsafeCompileDirReason('/var/folders/xx/T/abc', '/Users/example')).toMatch(
      /var\/folders/,
    );
    expect(unsafeCompileDirReason('/Users/example/tmp/abc', '/Users/example')).toMatch(/home/);
    expect(unsafeCompileDirReason('/home/example/tmp/abc', '/home/example')).toMatch(/home/);
    expect(unsafeCompileDirReason('/tmp', '/Users/example')).toMatch(/not under \/tmp/);
    expect(unsafeCompileDirReason('/private/tmp/sov-bun-compile-abc', '/Users/example')).toBeNull();
    expect(unsafeCompileDirReason('/tmp/sov-bun-compile-abc', '/home/example')).toBeNull();
    expect(unsafeCompileDirReason('C:/tmp/sov-bun-compile-abc', 'C:/Users/example')).toBeNull();
  });
});

describe('release-build-target — compileBinaries cwd and post-scan', () => {
  type Run = (
    bin: string,
    args: string[],
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv; throwOnError?: boolean },
  ) => void;

  function fixture(): { root: string; outside: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'sov-compile-src-'));
    const outside = mkdtempSync(join(tmpdir(), 'sov-compile-out-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'packages', 'tui'), { recursive: true });
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'build'));
    writeFileSync(join(root, 'src', 'main.ts'), 'console.log(1)\n');
    writeFileSync(join(root, '.git', 'config'), 'gitdir');
    writeFileSync(join(root, 'build', 'old-bin'), 'stale');
    writeFileSync(join(outside, 'esc.ts'), 'escaped-body');
    symlinkSync(join(outside, 'esc.ts'), join(root, 'src', 'escaped.ts'));
    return {
      root,
      outside,
      cleanup: () => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      },
    };
  }

  test('bun cwd is a 0700 /tmp copy with symlinks dereferenced, then the dir is removed', () => {
    const fix = fixture();
    const stage = mkdtempSync(join(tmpdir(), 'sov-compile-stage-'));
    mkdirSync(join(stage, 'bin'), { recursive: true });
    const calls: { bin: string; args: string[]; cwd?: string }[] = [];
    try {
      const fake: Run = (bin, args, opts) => {
        calls.push({ bin, args, ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
        expect(opts?.throwOnError).toBe(true);
        if (bin !== 'bun') return;
        const cwd = opts?.cwd ?? '';
        const real = realpathSync(cwd);
        expect(real.startsWith(`${realpathSync('/tmp')}${sep}`)).toBe(true);
        expect(real.includes(`${sep}var${sep}folders${sep}`)).toBe(false);
        const home = homedir();
        expect(real === home || real.startsWith(`${home}${sep}`)).toBe(false);
        expect(unsafeCompileDirReason(real, home)).toBeNull();
        expect(statSync(cwd).mode & 0o777).toBe(0o700);
        expect(existsSync(join(cwd, '.git'))).toBe(false);
        expect(existsSync(join(cwd, 'build'))).toBe(false);
        expect(existsSync(join(cwd, 'src', 'main.ts'))).toBe(true);
        const copied = join(cwd, 'src', 'escaped.ts');
        expect(lstatSync(copied).isSymbolicLink()).toBe(false);
        expect(readFileSync(copied, 'utf8')).toBe('escaped-body');
        const outfile = args.find((a) => a.startsWith('--outfile='))?.slice('--outfile='.length);
        if (!outfile) throw new Error('missing --outfile');
        writeFileSync(outfile, 'clean-sov');
      };
      compileBinaries(target('darwin-arm64'), stage, {
        run: fake,
        root: fix.root,
        home: homedir(),
      });
      const bunCall = calls.find((c) => c.bin === 'bun');
      const goCall = calls.find((c) => c.bin === 'go');
      expect(bunCall?.cwd).toBeTruthy();
      expect(existsSync(bunCall?.cwd ?? '')).toBe(false);
      expect(goCall?.args.slice(0, 3)).toEqual(['build', '-trimpath', '-ldflags=-s -w']);
      expect(goCall?.cwd).toBe(join(fix.root, 'packages', 'tui'));
      expect(bunCall?.args).toContain('src/main.ts');
      expect(bunCall?.args).toContain('--compile');
    } finally {
      fix.cleanup();
      rmSync(stage, { recursive: true, force: true });
    }
  });

  test('fails the build when bin/sov contains the home prefix or ~/code, and still removes the copy', () => {
    const fix = fixture();
    const stage = mkdtempSync(join(tmpdir(), 'sov-compile-stage-'));
    mkdirSync(join(stage, 'bin'), { recursive: true });
    let cwd = '';
    let goCalls = 0;
    try {
      const fake: Run = (bin, args, opts) => {
        if (bin === 'go') goCalls += 1;
        if (bin !== 'bun') return;
        cwd = opts?.cwd ?? '';
        const outfile = args.find((a) => a.startsWith('--outfile='))?.slice('--outfile='.length);
        if (!outfile) throw new Error('missing --outfile');
        writeFileSync(outfile, 'leaked /Users/example/code/sdk and ~/code/ops');
      };
      expect(() =>
        compileBinaries(target('linux-x64'), stage, {
          run: fake,
          root: fix.root,
          home: '/Users/example',
        }),
      ).toThrow(/\/Users\/example/);
      expect(cwd).not.toBe('');
      expect(existsSync(cwd)).toBe(false);
      expect(goCalls).toBe(0);

      const fakeTilde: Run = (bin, args) => {
        if (bin !== 'bun') return;
        const outfile = args.find((a) => a.startsWith('--outfile='))?.slice('--outfile='.length);
        if (!outfile) throw new Error('missing --outfile');
        writeFileSync(outfile, 'schedule ~/code/mission');
      };
      expect(() =>
        compileBinaries(target('linux-x64'), stage, {
          run: fakeTilde,
          root: fix.root,
          home: '/Users/runner',
        }),
      ).toThrow(/~\/code/);
    } finally {
      fix.cleanup();
      rmSync(stage, { recursive: true, force: true });
    }
  });

  test('removes the /tmp copy when bun fails', () => {
    const fix = fixture();
    const stage = mkdtempSync(join(tmpdir(), 'sov-compile-stage-'));
    let cwd = '';
    try {
      const fake: Run = (_bin, _args, opts) => {
        cwd = opts?.cwd ?? '';
        throw new Error('bun failed');
      };
      expect(() =>
        compileBinaries(target('darwin-arm64'), stage, { run: fake, root: fix.root }),
      ).toThrow(/bun failed/);
      expect(cwd).not.toBe('');
      expect(existsSync(cwd)).toBe(false);
    } finally {
      fix.cleanup();
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
