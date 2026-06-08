// SPIKE — runSubprocessExecutor tests. Grounds the stream-json parser on the
// REAL `claude -p ... --output-format stream-json --verbose` event shape
// captured live (system/init w/ session_id; assistant messages w/ text +
// tool_use content blocks; a terminal `result` event w/ is_error + num_turns;
// plus noise frames: system/hook_started, system/hook_response,
// rate_limit_event). The spawn fn is injected so tests feed canned JSONL — no
// real subprocess. Asserts:
//   - a tool-using transcript → the exact drainRunner result shape
//   - a non-zero exit → error terminal
//   - a timeout (AbortSignal) → error terminal
//   - the spawn argv carries the safe --permission-mode and NO dangerous flag

import { describe, expect, test } from 'bun:test';
import type { SubscriptionExecutorConfig } from '../../src/config/schema.js';
import {
  type SpawnFn,
  buildSubprocessArgs,
  runSubprocessExecutor,
} from '../../src/runtime/subprocessExecutor.js';

/** Build a fake spawn fn that emits the given JSONL lines on stdout, then
 *  exits with `exitCode`. Records the argv it was called with so tests can
 *  assert on the flags. */
function makeFakeSpawn(opts: {
  lines: string[];
  exitCode?: number;
  capturedArgv?: { argv: string[] };
  stderr?: string;
}): SpawnFn {
  return (argv, _spawnOpts) => {
    if (opts.capturedArgv) opts.capturedArgv.argv = argv;
    const body = opts.lines.join('\n') + (opts.lines.length > 0 ? '\n' : '');
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        if (opts.stderr) controller.enqueue(new TextEncoder().encode(opts.stderr));
        controller.close();
      },
    });
    return {
      stdout,
      stderr,
      stdin: { write: () => 0, end: () => {} },
      exited: Promise.resolve(opts.exitCode ?? 0),
      kill: () => {},
    };
  };
}

const baseConfig: SubscriptionExecutorConfig = {
  enabled: true,
  engine: 'claude-code',
  permissionMode: 'plan',
};

// A real-shaped tool-using transcript: init, an assistant turn that reads a
// file (tool_use), a user tool_result frame (noise to the parser), a second
// assistant text turn, then the terminal result. Plus hook + rate-limit noise.
const TOOL_USING_TRANSCRIPT: string[] = [
  JSON.stringify({
    type: 'system',
    subtype: 'hook_started',
    hook_name: 'SessionStart:startup',
    session_id: 'sess-abc',
  }),
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc', model: 'claude-opus' }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read the file.' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'README.md' } },
      ],
    },
    session_id: 'sess-abc',
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '# Hello' }],
    },
    session_id: 'sess-abc',
  }),
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'The file says Hello.' }],
    },
    session_id: 'sess-abc',
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    result: 'The file says Hello.',
    terminal_reason: 'completed',
    session_id: 'sess-abc',
    usage: { input_tokens: 100, output_tokens: 10 },
  }),
];

describe('runSubprocessExecutor — parse + shape', () => {
  test('tool-using transcript → drainRunner result shape', async () => {
    const result = await runSubprocessExecutor({
      prompt: 'read the readme',
      cwd: '/tmp/work',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines: TOOL_USING_TRANSCRIPT }),
    });

    expect(result.terminal.reason).toBe('completed');
    // finalAssistant is the LAST assistant text — what extractSummary reads.
    expect(result.finalAssistant).toBeDefined();
    const texts = (result.finalAssistant?.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    expect(texts.join('')).toBe('The file says Hello.');

    // num_turns → iterationsUsed.
    expect(result.iterationsUsed).toBe(2);
    // one tool_use across the transcript.
    expect(result.toolCallCount).toBe(1);
    expect(result.distinctToolNames).toEqual(['Read']);
    // messages reconstructed from the event stream (assistant + tool_result-
    // carrying user). At minimum the two assistant turns + the tool_result user.
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    // The reconstructed messages must carry the tool_use and the tool_result.
    const flat = JSON.stringify(result.messages);
    expect(flat).toContain('tool_use');
    expect(flat).toContain('tool_result');
  });

  test('result event with is_error:true → error terminal', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 5,
        result: 'hit the cap',
        session_id: 's',
      }),
    ];
    const result = await runSubprocessExecutor({
      prompt: 'p',
      cwd: '/tmp',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines }),
    });
    expect(result.terminal.reason).toBe('error');
    expect(result.terminal.error).toBeInstanceOf(Error);
  });

  test('non-zero exit → error terminal', async () => {
    const result = await runSubprocessExecutor({
      prompt: 'p',
      cwd: '/tmp',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines: [], exitCode: 1, stderr: 'claude: not logged in' }),
    });
    expect(result.terminal.reason).toBe('error');
    expect(result.terminal.error?.message ?? '').toContain('1');
  });

  test('no terminal result event (truncated stream) → error terminal', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      }),
    ];
    const result = await runSubprocessExecutor({
      prompt: 'p',
      cwd: '/tmp',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines, exitCode: 0 }),
    });
    expect(result.terminal.reason).toBe('error');
  });

  test('timeout (pre-aborted signal) → error terminal, kills the process', async () => {
    let killed = false;
    const spawn: SpawnFn = () => {
      const stdout = new ReadableStream<Uint8Array>({
        // Never closes on its own — only the abort/kill ends it.
        start() {},
      });
      const stderr = new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      });
      return {
        stdout,
        stderr,
        stdin: { write: () => 0, end: () => {} },
        // Resolve only after kill() so the executor's race resolves on timeout.
        exited: new Promise<number>((resolve) => {
          const iv = setInterval(() => {
            if (killed) {
              clearInterval(iv);
              resolve(143);
            }
          }, 1);
        }),
        kill: () => {
          killed = true;
        },
      };
    };
    const ctl = new AbortController();
    ctl.abort(); // pre-aborted → immediate timeout path
    const result = await runSubprocessExecutor({
      prompt: 'p',
      cwd: '/tmp',
      config: { ...baseConfig, timeoutMs: 10 },
      spawn,
      signal: ctl.signal,
    });
    expect(result.terminal.reason).toBe('error');
    expect(killed).toBe(true);
  });
});

describe('buildSubprocessArgs — safe posture', () => {
  test('includes -p, stream-json, verbose, and the safe --permission-mode', () => {
    const argv = buildSubprocessArgs({
      prompt: 'hello',
      config: { ...baseConfig, permissionMode: 'plan' },
    });
    expect(argv).toContain('-p');
    expect(argv).toContain('hello');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--verbose');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('plan');
  });

  test('defaults permissionMode to plan when unset (safest read-only default)', () => {
    const argv = buildSubprocessArgs({ prompt: 'x', config: { enabled: true } });
    const idx = argv.indexOf('--permission-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('plan');
  });

  test('NEVER emits a dangerous bypass flag', () => {
    const argv = buildSubprocessArgs({
      prompt: 'x',
      config: { ...baseConfig, permissionMode: 'acceptEdits' },
    });
    const joined = argv.join(' ');
    expect(joined).not.toContain('bypassPermissions');
    expect(joined).not.toContain('--dangerously-skip-permissions');
    expect(joined).not.toContain('--dangerously');
  });

  test('threads --max-turns when configured', () => {
    const argv = buildSubprocessArgs({
      prompt: 'x',
      config: { ...baseConfig, maxTurns: 8 },
    });
    const idx = argv.indexOf('--max-turns');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('8');
  });

  test('binary override is honored by the caller (argv excludes the binary)', () => {
    // buildSubprocessArgs returns ARGS only (no binary) — the binary is the
    // spawn command. Confirm the first arg is the headless flag, not a binary.
    const argv = buildSubprocessArgs({ prompt: 'x', config: baseConfig });
    expect(argv[0]).toBe('-p');
  });
});
