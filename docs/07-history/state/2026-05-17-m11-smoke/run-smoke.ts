// Phase 16.1 M11 — Default-flip smoke runner (Bun TypeScript edition).
//
// Exercises the boot-decision path end-to-end against the working-tree
// code (via `bun src/main.ts`). Captures stdout/stderr per scenario to
// the close-out directory. Designed to run from the repo root via:
//   bun docs/07-history/state/2026-05-17-m11-smoke/run-smoke.ts
//
// Cost: $0 — no real-Anthropic API calls. The dispatcher-command
// real-API verification happens via the gated M11 test added in
// tests/parity/m11RealAnthropicSmoke.test.ts.
//
// We use Bun.spawn with timeout: 6000ms so each scenario is bounded.
// Closing stdin via Bun.spawn's stdin='ignore' makes interactive
// surfaces bail out quickly when they discover no TTY input.

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface Scenario {
  name: string;
  env: Record<string, string>;
  args: string[];
  /** When set, writes this content to <tmpHome>/config.json before running. */
  configJson?: string;
  /** When true, temporarily moves <REPO_ROOT>/bin/sov-tui aside before
   *  the run and restores after, so findTuiBinary() returns null and
   *  exercises the main.ts missing-binary fallback path. */
  hideSovTui?: boolean;
}

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const OUT = resolve(import.meta.dir);
const TIMEOUT_MS = 6000;

const tmpHome = mkdtempSync(join(tmpdir(), 'sov-m11-smoke-home-'));
const tmpBundle = mkdtempSync(join(tmpdir(), 'sov-m11-smoke-bundle-'));

// Build a minimal harness bundle so sov has somewhere to point.
writeFileSync(
  join(tmpBundle, 'index.yaml'),
  'name: m11-smoke-bundle\nversion: 0.1.0\n',
);
mkdirSync(join(tmpBundle, 'business'), { recursive: true });
writeFileSync(join(tmpBundle, 'business', 'README.md'), '# smoke\n');

const scenarios: Scenario[] = [
  // 1: bare sov (no --ui, no SOV_UI, no config) → TUI boots
  { name: '01-bare-sov-default-tui', env: {}, args: [] },

  // 2: bare sov with sov-tui binary moved aside → fallback to REPL.
  // findTuiBinary() walks up looking for bin/sov-tui; we hide it so
  // the lookup returns null and main.ts hits the M11 fallback branch.
  {
    name: '02-missing-binary-fallback',
    env: {},
    args: [],
    hideSovTui: true,
  },

  // 3: SOV_UI=repl → REPL (env wins over default)
  { name: '03-env-sov-ui-repl', env: { SOV_UI: 'repl' }, args: [] },

  // 4: --ui repl → REPL (CLI flag wins)
  { name: '04-cli-ui-repl', env: {}, args: ['--ui', 'repl'] },

  // 5: --ui tui (CLI flag explicit) → TUI
  { name: '05-cli-ui-tui-explicit', env: {}, args: ['--ui', 'tui'] },

  // 6: config ui.surface=repl → REPL (config wins when CLI + env absent)
  {
    name: '06-config-surface-repl',
    env: {},
    args: [],
    configJson: JSON.stringify({ ui: { surface: 'repl' } }, null, 2),
  },

  // 7: config repl + CLI --ui tui → TUI (CLI wins)
  {
    name: '07-cli-tui-overrides-config-repl',
    env: {},
    args: ['--ui', 'tui'],
    configJson: JSON.stringify({ ui: { surface: 'repl' } }, null, 2),
  },

  // 8: config repl + SOV_UI=tui → TUI (env wins over config)
  {
    name: '08-env-tui-overrides-config-repl',
    env: { SOV_UI: 'tui' },
    args: [],
    configJson: JSON.stringify({ ui: { surface: 'repl' } }, null, 2),
  },

  // 9: invalid CLI flag → stderr warning, falls through (no other layer set → 'tui' default)
  { name: '09-invalid-cli-flag-warns', env: {}, args: ['--ui', 'xyzzy'] },

  // 10: invalid SOV_UI → silent fallthrough to default
  {
    name: '10-invalid-env-silent-fallthrough',
    env: { SOV_UI: 'nonsense' },
    args: [],
  },

  // 11: top-level --help (commands overview)
  { name: '11-help-text', env: {}, args: ['--help'] },

  // 12: --version (prints VERSION constant)
  { name: '12-version', env: {}, args: ['--version'] },

  // 13: sov chat --help (verify --ui description text changed to "tui (default) or repl")
  { name: '13-chat-help-ui-text', env: {}, args: ['chat', '--help'] },
];

async function runScenario(scenario: Scenario): Promise<void> {
  const outfile = join(OUT, `${scenario.name}.transcript.txt`);

  // Reset config for each scenario.
  const configPath = join(tmpHome, 'config.json');
  rmSync(configPath, { force: true });
  if (scenario.configJson !== undefined) {
    writeFileSync(configPath, scenario.configJson);
  }

  // Optionally hide the sov-tui binary for the missing-binary scenario.
  const sovTuiPath = join(REPO_ROOT, 'bin', 'sov-tui');
  const sovTuiStash = `${sovTuiPath}.stash-m11-smoke`;
  let stashed = false;
  if (scenario.hideSovTui === true && existsSync(sovTuiPath)) {
    renameSync(sovTuiPath, sovTuiStash);
    stashed = true;
  }

  const header = [
    `=== M11 smoke scenario: ${scenario.name} ===`,
    `env: ${JSON.stringify(scenario.env)}`,
    `args: bun src/main.ts ${scenario.args.join(' ')}`,
    `HARNESS_HOME=${tmpHome}`,
    `HARNESS_BUNDLE=${tmpBundle}`,
    scenario.configJson ? `config.json: ${scenario.configJson.replace(/\n/g, ' ')}` : 'config.json: (absent)',
    '--- stdout + stderr ---',
    '',
  ].join('\n');

  writeFileSync(outfile, header);

  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    const proc = Bun.spawn({
      cmd: ['bun', 'src/main.ts', ...scenario.args],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...scenario.env,
        HARNESS_HOME: tmpHome,
        HARNESS_BUNDLE: tmpBundle,
        // Force a fake TTY-less environment so interactive surfaces
        // bail out cleanly. NO_COLOR keeps the transcript ANSI-free.
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

  const footer = [
    '',
    '--- stdout above; stderr below ---',
    stderr,
    '',
    `--- exit code: ${exitCode} ---`,
    '',
  ].join('\n');

  writeFileSync(outfile, header + stdout + footer);

  process.stdout.write(
    `scenario=${scenario.name}  exit=${exitCode}  stdout_bytes=${stdout.length}  stderr_bytes=${stderr.length}  out=${outfile}\n`,
  );
}

process.stdout.write(`M11 smoke — writing transcripts to ${OUT}\n`);
process.stdout.write(`TMP_HOME=${tmpHome}\n`);
process.stdout.write(`TMP_BUNDLE=${tmpBundle}\n\n`);

try {
  for (const scenario of scenarios) {
    await runScenario(scenario);
  }
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpBundle, { recursive: true, force: true });
}

process.stdout.write(`\nM11 smoke — all scenarios complete. Transcripts in ${OUT}/\n`);
