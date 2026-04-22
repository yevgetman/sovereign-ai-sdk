#!/usr/bin/env bun
// CLI entry. Commander parses flags; dispatches to terminalRepl.
//
// Phase 0 scope: accepts --version, --bundle, --model, --max-tokens. The
// REPL itself is a stub until Phase 1.

import { Command } from '@commander-js/extra-typings';

const VERSION = '0.0.1';

function resolveBundlePath(cliArg: string | undefined): string {
  if (cliArg) return cliArg;
  const env = process.env['HARNESS_BUNDLE'];
  if (env) return env;
  throw new Error(
    'No bundle path provided. Pass --bundle <path> or set HARNESS_BUNDLE env var.',
  );
}

async function main(argv: string[]): Promise<void> {
  const program = new Command()
    .name('harness')
    .description('Sovereign AI agent runtime')
    .version(VERSION);

  program
    .command('chat', { isDefault: true })
    .description('Start an interactive chat session against a harness bundle')
    .option('-b, --bundle <path>', 'path to the harness bundle (or HARNESS_BUNDLE env)')
    .option('-m, --model <name>', 'model name', 'claude-opus-4-7')
    .option('--max-tokens <n>', 'max tokens per turn', '4096')
    .action(async (opts) => {
      const bundlePath = resolveBundlePath(opts.bundle);
      const { runRepl } = await import('./ui/terminalRepl.js');
      await runRepl({ bundlePath });
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`harness: ${msg}\n`);
  process.exit(1);
});
