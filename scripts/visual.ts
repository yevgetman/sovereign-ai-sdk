// Visual TUI testing runner. Iterates `.harness/visual/scenarios/*.tape`
// and renders each one to `.harness/visual/output/<name>.png` via VHS.
//
// Usage:
//   bun run visual            # render all scenarios
//   bun run visual splash     # render a single scenario by name
//
// Companion docs: .harness/visual/README.md

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCENARIOS_DIR = join(REPO_ROOT, '.harness', 'visual', 'scenarios');
const OUTPUT_DIR = join(REPO_ROOT, '.harness', 'visual', 'output');

function listScenarios(): string[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.tape') && !f.startsWith('_'))
    .map((f) => f.replace(/\.tape$/, ''))
    .sort();
}

async function renderOne(name: string): Promise<{ name: string; ok: boolean; ms: number }> {
  const tape = join(SCENARIOS_DIR, `${name}.tape`);
  if (!existsSync(tape)) {
    process.stderr.write(`visual: scenario not found: ${name} (looked at ${tape})\n`);
    return { name, ok: false, ms: 0 };
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
  if (ok) process.stdout.write(`OK (${ms}ms) → .harness/visual/output/${name}.png\n`);
  return { name, ok, ms };
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
  const results: Awaited<ReturnType<typeof renderOne>>[] = [];
  for (const name of targets) {
    results.push(await renderOne(name));
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} of ${results.length} scenarios failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\n${results.length} scenarios rendered.\n`);
}

void main();
