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
import type { ObserveInput } from '../../src/learning/observer.js';
import {
  type SpawnFn,
  buildSubprocessArgs,
  runSubprocessExecutor,
} from '../../src/runtime/subprocessExecutor.js';
import type { TraceEvent } from '../../src/trace/types.js';

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

// A real-shaped TWO-tool transcript grounded on the LIVE captured stream-json
// (claude v2.1.168: `claude -p "list files…" --output-format stream-json
// --verbose --permission-mode plan`). The real tool_use carries id/name/input
// (+ a `caller` field we drop); the matching tool_result rides a `type:'user'`
// frame with `{tool_use_id, type:'tool_result', content:<string>, is_error}`.
// Here: a successful Bash, then a Read that ERRORS — so the replay must map
// is_error → ObservationStatus across both branches.
const TWO_TOOL_TRANSCRIPT: string[] = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-xyz', model: 'claude-opus' }),
  // assistant turn 1 — a Bash tool_use (the live shape carries a `caller`).
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Listing the files.' },
        {
          type: 'tool_use',
          id: 'toolu_bash_1',
          name: 'Bash',
          input: { command: 'ls -1A', description: 'List all files' },
          caller: { type: 'direct' },
        },
      ],
    },
    session_id: 'sess-xyz',
  }),
  // tool_result for the Bash — success.
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_bash_1',
          content: 'a.txt\nb.txt\nc.txt',
          is_error: false,
        },
      ],
    },
    session_id: 'sess-xyz',
  }),
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
  // assistant turn 2 — a Read tool_use that will error.
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { path: 'nope.txt' } },
      ],
    },
    session_id: 'sess-xyz',
  }),
  // tool_result for the Read — ERROR.
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_read_1',
          content: 'Error: file not found: nope.txt',
          is_error: true,
        },
      ],
    },
    session_id: 'sess-xyz',
  }),
  // assistant final text.
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'There are 3 files.' }] },
    session_id: 'sess-xyz',
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    result: 'There are 3 files.',
    session_id: 'sess-xyz',
  }),
];

describe('runSubprocessExecutor — learning replay (per-tool observations + trace)', () => {
  test('replays each tool_use/tool_result into the observer with orchestrator-parity fields', async () => {
    const observed: ObserveInput[] = [];
    const traced: TraceEvent[] = [];

    const result = await runSubprocessExecutor({
      prompt: 'list files',
      cwd: '/tmp/work',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines: TWO_TOOL_TRANSCRIPT }),
      learningObserver: { observe: (i) => observed.push(i) },
      traceRecorder: (e) => traced.push(e),
    });

    // Result shape is unchanged by the replay.
    expect(result.terminal.reason).toBe('completed');
    expect(result.toolCallCount).toBe(2);
    expect(result.distinctToolNames).toEqual(['Bash', 'Read']);

    // One observation per tool call, in stream order.
    expect(observed).toHaveLength(2);

    // Bash — success. Fields mirror what the orchestrator builds:
    //   toolName, toolInput (verbatim), status, durationMs, traceId=tool_use_id.
    expect(observed[0]).toMatchObject({
      toolName: 'Bash',
      toolInput: { command: 'ls -1A', description: 'List all files' },
      status: 'success',
      traceId: 'toolu_bash_1',
    });
    expect(observed[0]?.durationMs).toBeGreaterThanOrEqual(0);
    // No harness ToolObservation envelope on a subprocess tool result.
    expect(observed[0]?.observationEnvelope).toBeUndefined();

    // Read — is_error:true → status 'error'.
    expect(observed[1]).toMatchObject({
      toolName: 'Read',
      toolInput: { path: 'nope.txt' },
      status: 'error',
      traceId: 'toolu_read_1',
    });

    // Trace bracket per tool: tool_start then tool_end (success) / tool_error.
    const bashStart = traced.find((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_bash_1');
    const bashEnd = traced.find((e) => e.type === 'tool_end' && e.toolUseId === 'toolu_bash_1');
    expect(bashStart).toBeDefined();
    expect(bashEnd).toBeDefined();
    if (bashEnd && bashEnd.type === 'tool_end') {
      expect(bashEnd.tool).toBe('Bash');
      // outputBytes mirrors the orchestrator (byte length of the result content).
      expect(bashEnd.outputBytes).toBe(Buffer.byteLength('a.txt\nb.txt\nc.txt', 'utf8'));
    }

    const readStart = traced.find((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_read_1');
    const readErr = traced.find((e) => e.type === 'tool_error' && e.toolUseId === 'toolu_read_1');
    expect(readStart).toBeDefined();
    expect(readErr).toBeDefined();
    if (readErr && readErr.type === 'tool_error') {
      expect(readErr.tool).toBe('Read');
      expect(readErr.message).toContain('file not found');
    }
    // The errored tool produced NO tool_end (parity with the orchestrator,
    // which records tool_error XOR tool_end).
    expect(
      traced.find((e) => e.type === 'tool_end' && e.toolUseId === 'toolu_read_1'),
    ).toBeUndefined();
  });

  test('messages[] is faithful — carries tool_use AND tool_result blocks, not just final text', async () => {
    const result = await runSubprocessExecutor({
      prompt: 'list files',
      cwd: '/tmp/work',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines: TWO_TOOL_TRANSCRIPT }),
    });

    const flat = JSON.stringify(result.messages);
    // Both tool_use blocks present.
    expect(flat).toContain('toolu_bash_1');
    expect(flat).toContain('toolu_read_1');
    // Both tool_result blocks present (the is_error flag survives).
    expect(flat).toContain('tool_result');
    expect(flat).toContain('file not found');
    // The final assistant text is also there.
    expect(flat).toContain('There are 3 files.');

    // Concretely: at least one assistant message carries a tool_use, and at
    // least one user message carries a tool_result.
    const hasToolUse = result.messages.some(
      (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'),
    );
    const hasToolResult = result.messages.some(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'),
    );
    expect(hasToolUse).toBe(true);
    expect(hasToolResult).toBe(true);
  });

  test('no observer/trace passed → clean no-op (back-compat with the spike)', async () => {
    // The original spike tests pass no observer/trace. The replay must be inert.
    const result = await runSubprocessExecutor({
      prompt: 'list files',
      cwd: '/tmp/work',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines: TWO_TOOL_TRANSCRIPT }),
    });
    // No throw; the result shape is exactly the pre-replay contract.
    expect(result.terminal.reason).toBe('completed');
    expect(result.toolCallCount).toBe(2);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test('a tool_use with no matching tool_result is still observed (best-effort)', async () => {
    // Truncated/odd streams: a tool_use whose result frame never arrived.
    // The orchestrator always produces a tool_result (even on throw), but a
    // subprocess stream can drop one — we still observe the call so the corpus
    // sees the tool was attempted, defaulting to success (no error signal).
    const observed: ObserveInput[] = [];
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_orphan', name: 'Grep', input: { pattern: 'x' } }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        result: 'done',
      }),
    ];
    await runSubprocessExecutor({
      prompt: 'p',
      cwd: '/tmp',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines }),
      learningObserver: { observe: (i) => observed.push(i) },
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      toolName: 'Grep',
      status: 'success',
      traceId: 'tu_orphan',
    });
  });

  test('error terminal → no replay (no tools observed on a failed run)', async () => {
    const observed: ObserveInput[] = [];
    const traced: TraceEvent[] = [];
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 5,
        result: 'hit the cap',
      }),
    ];
    const result = await runSubprocessExecutor({
      prompt: 'p',
      cwd: '/tmp',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines }),
      learningObserver: { observe: (i) => observed.push(i) },
      traceRecorder: (e) => traced.push(e),
    });
    expect(result.terminal.reason).toBe('error');
    // No tool_use in the stream → nothing to replay.
    expect(observed).toHaveLength(0);
    expect(traced.filter((e) => e.type === 'tool_start')).toHaveLength(0);
  });
});
