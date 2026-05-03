#!/usr/bin/env bun
// Entry point for the semantic test suite. Run with `bun run test:semantic`
// or `bun tests/semantic/run.ts`. Exits non-zero on any fail/error so this
// is CI-safe. The framework never imports from src/, so this script can
// be lifted to any project that has a `sov`-style stdin-driven REPL.
//
// Judge backends:
//   claude-code (default)  shells out to your authenticated `claude` CLI;
//                          uses your subscription, costs no API tokens.
//   anthropic-api          direct Anthropic SDK call; needs ANTHROPIC_API_KEY.
//   auto                   prefer claude-code if `claude` is on PATH else api.
//
// Flags:
//   --filter <s>          only run tests whose id/name/category contains <s>
//   --binary <s>          binary to spawn (default: sov; env SEMANTIC_BINARY overrides)
//   --judge <name>        judge backend: claude-code | anthropic-api | auto (default: auto)
//   --judge-model <s>     model id for the judge (passed to the chosen backend)
//   --claude-binary <s>   path to claude CLI (default: claude)
//   --include-slow        include tests marked slow:true
//   --verbose             print full transcripts on failure
//   --list                list discovered tests and exit
//   --help                print this help

import { join } from 'node:path';
import { selectJudge } from './framework/judges/index.js';
import type { JudgeBackendName } from './framework/judges/index.js';
import { createConsoleReporter } from './framework/reporter.js';
import { loadTestsFromDir, runSuite } from './framework/runner.js';

interface CliFlags {
  filter?: string;
  binary?: string;
  judge: JudgeBackendName | 'auto';
  judgeModel?: string;
  claudeBinary?: string;
  includeSlow: boolean;
  verbose: boolean;
  list: boolean;
  help: boolean;
}

function takeNext(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return v;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = {
    judge: 'auto',
    includeSlow: false,
    verbose: false,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--filter':
        out.filter = takeNext(argv, ++i, '--filter');
        break;
      case '--binary':
        out.binary = takeNext(argv, ++i, '--binary');
        break;
      case '--judge': {
        const v = takeNext(argv, ++i, '--judge');
        if (v !== 'claude-code' && v !== 'anthropic-api' && v !== 'auto') {
          console.error(`--judge must be one of: claude-code, anthropic-api, auto (got: ${v})`);
          process.exit(2);
        }
        out.judge = v;
        break;
      }
      case '--judge-model':
        out.judgeModel = takeNext(argv, ++i, '--judge-model');
        break;
      case '--claude-binary':
        out.claudeBinary = takeNext(argv, ++i, '--claude-binary');
        break;
      case '--include-slow':
        out.includeSlow = true;
        break;
      case '--verbose':
      case '-v':
        out.verbose = true;
        break;
      case '--list':
        out.list = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        if (a?.startsWith('--')) {
          console.error(`unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`Sovereign AI semantic test suite

Usage: bun tests/semantic/run.ts [flags]

Flags:
  --filter <s>          Only run tests whose id/name/category contains <s>
  --binary <s>          Binary to spawn (default: sov; env SEMANTIC_BINARY overrides)
  --judge <name>        Judge backend: claude-code | anthropic-api | auto (default: auto)
  --judge-model <s>     Model for the chosen judge backend (optional)
  --claude-binary <s>   Path to claude CLI (default: claude)
  --include-slow        Include tests marked slow:true
  --verbose, -v         Print full transcripts on failure
  --list                List discovered tests and exit
  --help, -h            Print this help

Default judge: claude-code (uses your authenticated claude CLI subscription, no API tokens).
Set ANTHROPIC_API_KEY and pass --judge anthropic-api if you prefer the API path.
`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  const suitesDir = join(import.meta.dir, 'suites');
  const tests = await loadTestsFromDir(suitesDir);

  if (flags.list) {
    for (const t of tests) {
      const slow = t.slow ? ' [slow]' : '';
      console.log(`${t.category}.${t.id}${slow} — ${t.name}`);
    }
    return;
  }

  const binary = flags.binary ?? process.env.SEMANTIC_BINARY ?? 'sov';
  const judge = await selectJudge({
    backend: flags.judge,
    ...(flags.judgeModel ? { model: flags.judgeModel } : {}),
    ...(flags.claudeBinary ? { binary: flags.claudeBinary } : {}),
  });
  const judgeLabel = describeJudge(flags);
  const reporter = createConsoleReporter({ verbose: flags.verbose });

  const summary = await runSuite(tests, {
    binary,
    includeSlow: flags.includeSlow,
    verbose: flags.verbose,
    judge,
    judgeLabel,
    reporter,
    ...(flags.filter ? { filter: flags.filter } : {}),
  });

  process.exit(summary.failed === 0 && summary.errored === 0 ? 0 : 1);
}

function describeJudge(flags: CliFlags): string {
  const backend = flags.judge === 'auto' ? 'auto (claude-code preferred)' : flags.judge;
  const model = flags.judgeModel ? ` · ${flags.judgeModel}` : '';
  return `${backend}${model}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
