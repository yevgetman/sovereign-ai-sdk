// Phase 16.1 M12 — REPL deprecation warning smoke runner.
//
// Focused on the M12 predicate: warning fires on explicit --ui repl /
// SOV_UI=repl / ui.surface=repl opt-ins, stays silent on missing-binary
// fallback or default-TUI. Each scenario writes a transcript + asserts
// the deprecation string is present or absent as expected.
//
// Cost: $0 — no real-Anthropic calls. Run from repo root:
//   bun docs/07-history/state/2026-05-19-m12-smoke/run-smoke.ts

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface Scenario {
  name: string;
  env: Record<string, string>;
  args: string[];
  configJson?: string;
  hideSovTui?: boolean;
  /** Expected behavior: warning must be present ('present') or absent ('absent'). */
  expectDeprecation: 'present' | 'absent';
}

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const OUT = resolve(import.meta.dir);
const TIMEOUT_MS = 6000;
const DEPRECATION_NEEDLE = 'the readline REPL is deprecated';

const tmpHome = mkdtempSync(join(tmpdir(), 'sov-m12-smoke-home-'));
const tmpBundle = mkdtempSync(join(tmpdir(), 'sov-m12-smoke-bundle-'));

writeFileSync(
  join(tmpBundle, 'index.yaml'),
  'name: m12-smoke-bundle\nversion: 0.1.0\n',
);
mkdirSync(join(tmpBundle, 'business'), { recursive: true });
writeFileSync(join(tmpBundle, 'business', 'README.md'), '# smoke\n');

const scenarios: Scenario[] = [
  // 1: --ui repl (source=cli) → warning fires
  {
    name: '01-cli-ui-repl-deprecation-fires',
    env: {},
    args: ['--ui', 'repl'],
    expectDeprecation: 'present',
  },
  // 2: SOV_UI=repl (source=env) → warning fires
  {
    name: '02-env-sov-ui-repl-deprecation-fires',
    env: { SOV_UI: 'repl' },
    args: [],
    expectDeprecation: 'present',
  },
  // 3: ui.surface=repl in config (source=config) → warning fires
  {
    name: '03-config-surface-repl-deprecation-fires',
    env: {},
    args: [],
    configJson: JSON.stringify({ ui: { surface: 'repl' } }, null, 2),
    expectDeprecation: 'present',
  },
  // 4: --ui repl + SOV_NO_DEPRECATION_WARNING=1 → warning suppressed
  {
    name: '04-suppression-flag-silences-warning',
    env: { SOV_NO_DEPRECATION_WARNING: '1' },
    args: ['--ui', 'repl'],
    expectDeprecation: 'absent',
  },
  // 5: bare sov with sov-tui hidden → missing-binary fallback, NO deprecation
  // (the M11 'sov-tui binary not found' warning still fires, but the M12
  //  deprecation does not — ADR M12-01.)
  {
    name: '05-missing-binary-fallback-no-deprecation',
    env: {},
    args: [],
    hideSovTui: true,
    expectDeprecation: 'absent',
  },
  // 6: bare sov (default TUI) → no deprecation, no fallback
  {
    name: '06-default-tui-no-deprecation',
    env: {},
    args: [],
    expectDeprecation: 'absent',
  },
];

interface ScenarioResult {
  name: string;
  exitCode: number;
  deprecationFound: boolean;
  expectDeprecation: 'present' | 'absent';
  pass: boolean;
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const outfile = join(OUT, `${scenario.name}.transcript.txt`);

  const configPath = join(tmpHome, 'config.json');
  rmSync(configPath, { force: true });
  if (scenario.configJson !== undefined) {
    writeFileSync(configPath, scenario.configJson);
  }

  const sovTuiPath = join(REPO_ROOT, 'bin', 'sov-tui');
  const sovTuiStash = `${sovTuiPath}.stash-m12-smoke`;
  let stashed = false;
  if (scenario.hideSovTui === true && existsSync(sovTuiPath)) {
    renameSync(sovTuiPath, sovTuiStash);
    stashed = true;
  }

  const header = [
    `=== M12 smoke scenario: ${scenario.name} ===`,
    `env: ${JSON.stringify(scenario.env)}`,
    `args: bun src/main.ts ${scenario.args.join(' ')}`,
    `HARNESS_HOME=${tmpHome}`,
    `HARNESS_BUNDLE=${tmpBundle}`,
    scenario.configJson
      ? `config.json: ${scenario.configJson.replace(/\n/g, ' ')}`
      : 'config.json: (absent)',
    `expect deprecation: ${scenario.expectDeprecation}`,
    '--- stdout + stderr ---',
    '',
  ].join('\n');

  let exitCode = -1;
  let stdout = '';
  let stderr = '';
  try {
    const proc = Bun.spawn({
      cmd: ['bun', 'src/main.ts', ...scenario.args],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...scenario.env,
        HARNESS_HOME: tmpHome,
        HARNESS_BUNDLE: tmpBundle,
        NO_COLOR: '1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: TIMEOUT_MS,
    });
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exitCode = await proc.exited;
  } finally {
    if (stashed) {
      renameSync(sovTuiStash, sovTuiPath);
    }
  }

  const deprecationFound = stderr.includes(DEPRECATION_NEEDLE) || stdout.includes(DEPRECATION_NEEDLE);
  const pass =
    (scenario.expectDeprecation === 'present' && deprecationFound) ||
    (scenario.expectDeprecation === 'absent' && !deprecationFound);

  const footer = [
    '',
    '--- stdout above; stderr below ---',
    stderr,
    '',
    `--- exit code: ${exitCode} ---`,
    `--- deprecation present: ${deprecationFound} (expected ${scenario.expectDeprecation}) — ${pass ? 'PASS' : 'FAIL'} ---`,
    '',
  ].join('\n');

  writeFileSync(outfile, header + stdout + footer);

  process.stdout.write(
    `scenario=${scenario.name}  exit=${exitCode}  deprecation=${deprecationFound ? 'present' : 'absent'}  expect=${scenario.expectDeprecation}  ${pass ? 'PASS' : 'FAIL'}\n`,
  );

  return {
    name: scenario.name,
    exitCode,
    deprecationFound,
    expectDeprecation: scenario.expectDeprecation,
    pass,
  };
}

process.stdout.write(`M12 smoke — writing transcripts to ${OUT}\n`);
process.stdout.write(`TMP_HOME=${tmpHome}\n`);
process.stdout.write(`TMP_BUNDLE=${tmpBundle}\n\n`);

const results: ScenarioResult[] = [];
try {
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpBundle, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
process.stdout.write(
  `\nM12 smoke — ${results.length - failed.length}/${results.length} scenarios pass\n`,
);
if (failed.length > 0) {
  process.stdout.write('FAILED:\n');
  for (const r of failed) {
    process.stdout.write(
      `  ${r.name}: expected ${r.expectDeprecation}, got ${r.deprecationFound ? 'present' : 'absent'}\n`,
    );
  }
  process.exit(1);
}
process.stdout.write(`All transcripts in ${OUT}/\n`);
