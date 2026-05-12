// Judge backend factory + auto-detection. Adding a new backend means:
//   1. Create framework/judges/<name>.ts that exports a `create<Name>Judge`
//      factory returning a `Judge` (see types.ts).
//   2. Wire it into selectJudge() below.
//   3. Document it in tests/semantic/README.md.
// Nothing else — runner.ts and run.ts treat the Judge as opaque.

import type { Judge } from '../types.js';
import { createAnthropicApiJudge } from './anthropicApi.js';
import { createClaudeCodeJudge } from './claudeCode.js';
import { createStringMatchJudge } from './stringMatch.js';

export type JudgeBackendName = 'claude-code' | 'anthropic-api' | 'string-match';

export interface SelectJudgeOptions {
  backend: JudgeBackendName | 'auto';
  /** Model override passed through to the chosen backend. */
  model?: string;
  /** Anthropic API key (only consulted by anthropic-api backend). */
  apiKey?: string;
  /** claude binary path override (only consulted by claude-code backend). */
  binary?: string;
}

/** Pick a judge backend. `auto` prefers claude-code if `claude` is on PATH,
 *  else falls back to anthropic-api when ANTHROPIC_API_KEY is set. Throws
 *  with a clear message when neither is available. */
export async function selectJudge(opts: SelectJudgeOptions): Promise<Judge> {
  const backend = opts.backend === 'auto' ? await autoDetect(opts) : opts.backend;

  switch (backend) {
    case 'claude-code': {
      return createClaudeCodeJudge({
        ...(opts.binary ? { binary: opts.binary } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      });
    }
    case 'anthropic-api': {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          'anthropic-api judge requires ANTHROPIC_API_KEY (env var or --api-key flag).',
        );
      }
      return createAnthropicApiJudge({
        apiKey,
        ...(opts.model ? { model: opts.model } : {}),
      });
    }
    case 'string-match': {
      return createStringMatchJudge();
    }
    default: {
      const exhaustive: never = backend;
      throw new Error(`unknown judge backend: ${exhaustive}`);
    }
  }
}

async function autoDetect(opts: SelectJudgeOptions): Promise<JudgeBackendName> {
  const claudeBinary = opts.binary ?? 'claude';
  if (await commandExists(claudeBinary)) return 'claude-code';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic-api';
  throw new Error(
    `No judge available. Install the \`${claudeBinary}\` CLI (recommended — uses your subscription) or set ANTHROPIC_API_KEY to use the api backend.`,
  );
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['which', cmd], { stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
