// Visual TUI testing runner. Iterates `.harness/visual/scenarios/*.tape`
// and renders each one via VHS, then verifies the declared Screenshot
// outputs exist on disk.
//
// A scenario can declare ONE Screenshot (`<name>.png`) or MANY
// (`<name>-NN-<step>.png`). The runner discovers the declared outputs
// by parsing the tape's `Screenshot` lines so it doesn't need to know
// in advance how many PNGs to expect.
//
// Usage:
//   bun run visual                # render all scenarios
//   bun run visual splash         # render a single scenario by name
//
// Companion docs: docs/conventions/visual-tui-qa.md
//   The convention doc is the record-of-truth for naming, sleep
//   buffers, and the multi-screenshot pattern.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCENARIOS_DIR = join(REPO_ROOT, '.harness', 'visual', 'scenarios');

type RenderResult = {
  name: string;
  ok: boolean;
  ms: number;
  /** PNG paths the tape declared via Screenshot directives (relative to repo). */
  declared: string[];
  /** Subset of declared that actually exists on disk after the render. */
  written: string[];
  /** Subset of declared that the runner expected but didn't find. */
  missing: string[];
};

function listScenarios(): string[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.tape') && !f.startsWith('_'))
    .map((f) => f.replace(/\.tape$/, ''))
    .sort();
}

/** Pull every `Screenshot <path>` line out of a tape. The runner uses
 *  these to both pre-validate the tape and post-validate that VHS wrote
 *  the expected files. Returns paths exactly as written in the tape
 *  (relative to repo root). */
function parseScreenshotPaths(tapeBody: string): string[] {
  const out: string[] = [];
  for (const line of tapeBody.split('\n')) {
    const m = line.match(/^\s*Screenshot\s+(\S+)\s*$/);
    if (m) out.push(m[1] as string);
  }
  return out;
}

async function renderOne(name: string): Promise<RenderResult> {
  const tape = join(SCENARIOS_DIR, `${name}.tape`);
  if (!existsSync(tape)) {
    process.stderr.write(`visual: scenario not found: ${name} (looked at ${tape})\n`);
    return { name, ok: false, ms: 0, declared: [], written: [], missing: [] };
  }
  const tapeBody = readFileSync(tape, 'utf8');
  const declared = parseScreenshotPaths(tapeBody);
  if (declared.length === 0) {
    process.stderr.write(`visual: scenario ${name} has no Screenshot directives\n`);
    return { name, ok: false, ms: 0, declared, written: [], missing: [] };
  }

  const start = Date.now();
  process.stdout.write(`▶ rendering ${name} ... `);
  const ok = await new Promise<boolean>((resolveResult) => {
    const child = spawn('vhs', [tape], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      process.stdout.write(`FAIL\n`);
      process.stderr.write(`  spawn error: ${err.message}\n`);
      resolveResult(false);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolveResult(true);
      } else {
        process.stdout.write(`FAIL (exit ${code})\n`);
        if (stderr.trim()) process.stderr.write(`  ${stderr.trim()}\n`);
        resolveResult(false);
      }
    });
  });
  const ms = Date.now() - start;

  // Post-validate: every declared PNG should now exist on disk.
  const written: string[] = [];
  const missing: string[] = [];
  for (const p of declared) {
    const abs = join(REPO_ROOT, p);
    if (existsSync(abs) && statSync(abs).isFile()) {
      written.push(p);
    } else {
      missing.push(p);
    }
  }

  if (ok && missing.length === 0) {
    if (declared.length === 1) {
      process.stdout.write(`OK (${ms}ms) → ${declared[0]}\n`);
    } else {
      process.stdout.write(`OK (${ms}ms) — ${declared.length} screenshots:\n`);
      for (const p of declared) process.stdout.write(`    ${p}\n`);
    }
  } else if (ok && missing.length > 0) {
    process.stdout.write(`PARTIAL (${ms}ms) — ${written.length}/${declared.length} written\n`);
    for (const p of missing) process.stderr.write(`    missing: ${p}\n`);
  }

  return {
    name,
    ok: ok && missing.length === 0,
    ms,
    declared,
    written,
    missing,
  };
}

async function main(): Promise<void> {
  const filter = process.argv[2];
  const all = listScenarios();
  const targets = filter ? all.filter((n) => n === filter) : all;
  if (targets.length === 0) {
    if (filter) {
      process.stderr.write(`visual: no scenario matches "${filter}"\n`);
      process.stderr.write(`  available: ${all.join(', ')}\n`);
    } else {
      process.stderr.write(`visual: no scenarios in ${SCENARIOS_DIR}\n`);
    }
    process.exit(1);
  }
  const results: RenderResult[] = [];
  for (const name of targets) {
    results.push(await renderOne(name));
  }
  const failed = results.filter((r) => !r.ok);
  const totalPngs = results.reduce((acc, r) => acc + r.written.length, 0);
  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} of ${results.length} scenarios failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\n${results.length} scenarios rendered (${totalPngs} PNG${totalPngs === 1 ? '' : 's'}).\n`);
}

void main();
