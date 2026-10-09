// Run the actual private consumer against a packed SDK without editing its checkout.
// Requires an explicit source path. No private source is copied into this repo.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/canary/run-agent-casa-canary.mjs /path/to/real-estate-agent-runtime');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = mkdtempSync(join(tmpdir(), 'sov-agent-casa-'));
const env = Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
env.HOME = scratch; env.CI = '1';
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Downstream test output can include proprietary fixture details. Only summaries
  // are printed. A local failure log stays inside scratch until this process ends.
  if (result.error || result.status !== 0) {
    if (process.argv[3]) writeFileSync(resolve(process.argv[3]), `${result.stdout}\n${result.stderr}`, { mode: 0o600 });
    throw new Error(`Agent Casa compatibility failed: ${command} ${args.join(' ')} (exit ${result.status})`, { cause: result.error });
  }
  return result.stdout;
};
try {
  const revision = execFileSync('git', ['-C', resolve(source), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const archive = execFileSync('git', ['-C', resolve(source), 'archive', 'HEAD'], { maxBuffer: 128 * 1024 * 1024 });
  const extracted = spawnSync('tar', ['-xf', '-', '-C', scratch], { input: archive });
  if (extracted.status !== 0) throw new Error('Could not extract the consumer source snapshot');
  const manifest = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'));
  if (manifest.name !== 'real-estate-agent-runtime') throw new Error('Expected the named Agent Casa consumer');
  // Package scripts are not allowed to run during dependency installation.
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], scratch);
  const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', scratch], join(repo, 'packages/sdk')));
  const tarball = join(scratch, pack[0].filename);
  run('npm', ['install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', tarball], scratch);
  run('npm', ['run', 'typecheck'], scratch);
  const output = run('npm', ['test', '--', '--reporter=json'], scratch);
  const start = output.indexOf('{');
  if (start < 0) throw new Error('Consumer tests produced no JSON result');
  const report = JSON.parse(output.slice(start));
  const counts = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests'];
  if (report.success !== true || counts.some(key => !Number.isSafeInteger(report[key]) || report[key] < 0) ||
      report.numTotalTests < 1 || report.numPassedTests < 1 || report.numFailedTests !== 0 ||
      report.numTotalTests !== report.numPassedTests + report.numPendingTests) {
    throw new Error('Consumer tests did not produce a nonempty passing result');
  }
  const sdk = JSON.parse(readFileSync(join(scratch, 'node_modules/@yevgetman/sov-sdk/package.json'), 'utf8')).version;
  console.log(JSON.stringify({ consumer: 'Agent Casa', consumerRevision: revision, sdk,
    passed: report.numPassedTests, pending: report.numPendingTests, failed: report.numFailedTests,
    node: process.version, sourceCheckoutUnchanged: true }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
