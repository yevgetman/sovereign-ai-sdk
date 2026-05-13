#!/usr/bin/env bun
// scripts/build-tui.ts
//
// Postinstall build: detect Go ≥ 1.24; build packages/tui/cmd/sov-tui to
// bin/sov-tui. On failure, print clear remediation and exit 0 — bun install
// keeps succeeding so the TS runtime is still usable; sov falls back to
// --ui repl with a one-line warning at launch.

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const TUI_DIR = join(REPO_ROOT, 'packages', 'tui');
const BIN_DIR = join(REPO_ROOT, 'bin');
const OUT = join(BIN_DIR, 'sov-tui');
// Min version is governed by our dependencies' own go.mod directives:
// bubbletea v1.3.10 declares go 1.24.0; bubbles v1.0.0 declares go 1.24.2.
// Go refuses to build when the toolchain is below any dependency's directive,
// so the script's gate must match what `go build` actually accepts.
const MIN_GO_MAJOR = 1;
const MIN_GO_MINOR = 24;

async function detectGo(): Promise<{ major: number; minor: number } | null> {
  try {
    const proc = Bun.spawn(['go', 'version'], { stdout: 'pipe', stderr: 'pipe' });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    // Format: "go version go1.22.0 darwin/arm64"
    const m = text.match(/go(\d+)\.(\d+)/);
    if (!m) return null;
    const majorStr = m[1];
    const minorStr = m[2];
    if (!majorStr || !minorStr) return null;
    return { major: parseInt(majorStr, 10), minor: parseInt(minorStr, 10) };
  } catch {
    return null;
  }
}

function warnNoGo(): void {
  console.warn('');
  console.warn('┌─────────────────────────────────────────────────────────────┐');
  console.warn('│  sov: Go ≥ 1.24 not detected on PATH                       │');
  console.warn('│                                                             │');
  console.warn('│  The TS runtime installed successfully and `sov --ui repl` │');
  console.warn('│  (the default) will work. To enable `sov --ui tui`, install │');
  console.warn('│  Go and re-run `sov upgrade`:                               │');
  console.warn('│                                                             │');
  console.warn('│    macOS:  brew install go                                  │');
  console.warn('│    Linux:  see https://go.dev/doc/install                   │');
  console.warn('│                                                             │');
  console.warn('└─────────────────────────────────────────────────────────────┘');
  console.warn('');
}

async function build(): Promise<boolean> {
  if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });
  const proc = Bun.spawn(['go', 'build', '-o', OUT, './cmd/sov-tui'], {
    cwd: TUI_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  return code === 0;
}

async function main(): Promise<void> {
  const go = await detectGo();
  if (go === null) {
    warnNoGo();
    return;
  }
  if (go.major < MIN_GO_MAJOR || (go.major === MIN_GO_MAJOR && go.minor < MIN_GO_MINOR)) {
    console.warn(`sov: Go ${go.major}.${go.minor} detected; need ≥ ${MIN_GO_MAJOR}.${MIN_GO_MINOR}.`);
    warnNoGo();
    return;
  }
  if (!existsSync(TUI_DIR)) {
    console.warn(`sov: packages/tui not present at ${TUI_DIR}; skipping TUI build.`);
    return;
  }
  console.log('sov: building TUI client (Go)...');
  const ok = await build();
  if (!ok) {
    console.warn('sov: TUI build failed. The TS runtime still works; `sov --ui repl` is unaffected.');
    return;
  }
  console.log(`sov: built ${OUT}`);
}

await main();
