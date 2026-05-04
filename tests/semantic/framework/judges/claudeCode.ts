// Claude Code judge — shells out to the local `claude` CLI in non-interactive
// print mode. Uses the user's authenticated session (Pro/Max subscription),
// so no API tokens are spent. Tools are disabled (`--tools ""`) and session
// persistence is off — the judge cannot touch any state outside the prompt
// it receives. Spawned in tmpdir() to keep it away from the repo cwd.
//
// We strip ANTHROPIC_API_KEY from the spawned env so the `claude` CLI falls
// back to the stored subscription credentials. Without this, a project-local
// .env or a shell-exported API key takes priority over the subscription and
// burns API credit (which is the wrong charging path for the judge).
//
// We deliberately DO NOT pass `--json-schema` here: empirically, combining
// schema validation with `--tools ""` and large prompts causes claude to
// return an empty `result` field (validator burns the response). Instead we
// instruct claude to emit JSON via the prompt, then use the tolerant
// parseVerdictFromText() to extract it.

import { tmpdir } from 'node:os';
import type { Judge } from '../types.js';
import { buildJudgePrompt, makeVerdict, parseVerdictFromText } from './prompt.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface ClaudeCodeJudgeOptions {
  /** Path to the claude binary. Default: 'claude' (resolved on PATH). */
  binary?: string;
  /** Pass --model <name> to claude. Default: claude-haiku-4-5-20251001 (cheap + fast). */
  model?: string;
  /** Per-call timeout in ms. Default: 120_000. */
  timeoutMs?: number;
}

export function createClaudeCodeJudge(opts: ClaudeCodeJudgeOptions = {}): Judge {
  const binary = opts.binary ?? 'claude';
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const baseArgs = [
    '--print',
    '--output-format',
    'json',
    '--model',
    model,
    '--tools',
    '', // disable all tool use; judge only reads + writes JSON
    '--no-session-persistence',
    '--disable-slash-commands',
  ];

  return async (test, transcript) => {
    const prompt = buildJudgePrompt(test, transcript);
    const proc = Bun.spawn([binary, ...baseArgs], {
      cwd: tmpdir(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: judgeSpawnEnv(),
    });
    proc.stdin.write(prompt);
    await proc.stdin.end();

    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(killer);

    if (timedOut) {
      throw new Error(`claude judge timed out after ${timeoutMs}ms`);
    }
    if (proc.exitCode !== 0) {
      throw new Error(
        `claude judge exited with code ${proc.exitCode}: ${stderr.slice(0, 800) || stdout.slice(0, 800)}`,
      );
    }

    const core = parseVerdictFromText(stdout);
    const cost = extractCost(stdout);
    return makeVerdict(core, {
      costUsd: cost.costUsd,
      tokens: cost.tokens,
      backend: 'claude-code',
    });
  };
}

/** Build the env handed to the spawned `claude` CLI. Strips
 *  ANTHROPIC_API_KEY (and a couple of variants Anthropic clients honor) so
 *  the CLI falls through to its stored subscription credentials. Without
 *  this, an `.env` or shell-exported API key wins and the judge burns API
 *  credit — wrong charging path for semantic testing. */
function judgeSpawnEnv(): Record<string, string> {
  const blocked = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (blocked.has(k)) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Pull cost / tokens from the claude --output-format json envelope when present.
 *  The envelope shape is: { type, subtype, total_cost_usd?, usage?: { input_tokens, output_tokens }, ... }.
 *  Subscription sessions report 0 cost; that's fine. Falls back to (0, 0/0) when fields are missing. */
function extractCost(raw: string): { costUsd: number; tokens: { input: number; output: number } } {
  try {
    const env = JSON.parse(raw.trim()) as {
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      costUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : 0,
      tokens: {
        input: env.usage?.input_tokens ?? 0,
        output: env.usage?.output_tokens ?? 0,
      },
    };
  } catch {
    return { costUsd: 0, tokens: { input: 0, output: 0 } };
  }
}
