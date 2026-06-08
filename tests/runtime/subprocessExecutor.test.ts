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
  canonicalizeToolForObservation,
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
    // distinctToolNames reports the CANONICAL name (Read→FileRead) so a
    // delegated read co-counts with a native FileRead.
    expect(result.distinctToolNames).toEqual(['FileRead']);
    // messages reconstructed from the event stream (assistant + tool_result-
    // carrying user). At minimum the two assistant turns + the tool_result user.
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    // The reconstructed messages must carry the tool_use and the tool_result.
    const flat = JSON.stringify(result.messages);
    expect(flat).toContain('tool_use');
    expect(flat).toContain('tool_result');
    // messages[] stays VERBATIM — the assistant tool_use block keeps Claude's
    // real 'Read' name (NOT the canonicalized FileRead). Canonicalization is
    // applied to the OBSERVATION + the distinctToolNames metric only.
    expect(flat).toContain('"name":"Read"');
    expect(flat).not.toContain('FileRead');
  });

  test('finalAssistant carries the final assistant text → a non-empty extractSummary', async () => {
    // Regression guard for the drive/TUI "(no summary)" path. The scheduler's
    // private extractSummary(finalAssistant) joins the final assistant message's
    // text blocks — the value that becomes DelegateResult.summary and, via
    // AgentTool, the delegated summary the model + display see. A canned
    // stream-json whose final assistant message is "There are 3 files." must
    // yield exactly that, so the summary the surface renders is non-empty.
    const result = await runSubprocessExecutor({
      prompt: 'count the files',
      cwd: '/tmp/work',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines: TWO_TOOL_TRANSCRIPT }),
    });

    expect(result.terminal.reason).toBe('completed');
    expect(result.finalAssistant).toBeDefined();
    // Mirror scheduler.ts extractSummary: join the final assistant's text blocks.
    const summary = (result.finalAssistant?.content ?? [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    expect(summary).toBe('There are 3 files.');
    expect(summary.length).toBeGreaterThan(0);
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
  // assistant turn 2 — a Read tool_use that will error. The LIVE Claude Code
  // shape carries `file_path` (NOT `path`) — confirmed against claude v2.1.168.
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'nope.txt' } },
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

    // Result shape is unchanged by the replay EXCEPT that distinctToolNames now
    // reports the harness's CANONICAL names (so a delegated Read co-counts with a
    // native FileRead). The count is naming-agnostic.
    expect(result.terminal.reason).toBe('completed');
    expect(result.toolCallCount).toBe(2);
    expect(result.distinctToolNames).toEqual(['Bash', 'FileRead']);

    // One observation per tool call, in stream order.
    expect(observed).toHaveLength(2);

    // Bash — success. The OBSERVATION is canonicalized for co-clustering:
    // Bash's name already matches the native tool, but Claude's `description`
    // (a Claude-only noise field a native Bash never carries) is dropped from
    // the observation input so the input hash co-identifies with a native Bash.
    // Load-bearing `command` is preserved.
    expect(observed[0]).toMatchObject({
      toolName: 'Bash',
      toolInput: { command: 'ls -1A' },
      status: 'success',
      traceId: 'toolu_bash_1',
    });
    expect((observed[0]?.toolInput as Record<string, unknown>).description).toBeUndefined();
    expect(observed[0]?.durationMs).toBeGreaterThanOrEqual(0);
    // No harness ToolObservation envelope on a subprocess tool result.
    expect(observed[0]?.observationEnvelope).toBeUndefined();

    // Read — is_error:true → status 'error'. The OBSERVATION is canonicalized to
    // the harness's native name + input key: Read→FileRead, file_path→path, so
    // it co-clusters with a native FileRead.
    expect(observed[1]).toMatchObject({
      toolName: 'FileRead',
      toolInput: { path: 'nope.txt' },
      status: 'error',
      traceId: 'toolu_read_1',
    });
    expect((observed[1]?.toolInput as Record<string, unknown>).file_path).toBeUndefined();

    // Trace bracket per tool stays VERBATIM (Claude's real names) — the trace is
    // a fidelity/operational record of what Claude actually did.
    const bashStart = traced.find((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_bash_1');
    const bashEnd = traced.find((e) => e.type === 'tool_end' && e.toolUseId === 'toolu_bash_1');
    expect(bashStart).toBeDefined();
    expect(bashEnd).toBeDefined();
    if (bashStart && bashStart.type === 'tool_start') {
      expect(bashStart.tool).toBe('Bash');
    }
    if (bashEnd && bashEnd.type === 'tool_end') {
      expect(bashEnd.tool).toBe('Bash');
      // outputBytes mirrors the orchestrator (byte length of the result content).
      expect(bashEnd.outputBytes).toBe(Buffer.byteLength('a.txt\nb.txt\nc.txt', 'utf8'));
    }

    const readStart = traced.find((e) => e.type === 'tool_start' && e.toolUseId === 'toolu_read_1');
    const readErr = traced.find((e) => e.type === 'tool_error' && e.toolUseId === 'toolu_read_1');
    expect(readStart).toBeDefined();
    expect(readErr).toBeDefined();
    // The trace keeps Claude's verbatim 'Read' (NOT the canonicalized FileRead).
    if (readStart && readStart.type === 'tool_start') {
      expect(readStart.tool).toBe('Read');
    }
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

  test('an UNMAPPED Claude tool (WebFetch) is observed VERBATIM (no native equivalent)', async () => {
    // Claude tools with no harness-native counterpart (WebFetch, Task, MCP
    // tools, …) must pass through the observation unchanged — there is nothing
    // to co-cluster them with, and rewriting them would corrupt the corpus.
    const observed: ObserveInput[] = [];
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_fetch',
              name: 'WebFetch',
              input: { url: 'https://example.com', prompt: 'summarize' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_fetch', content: 'ok', is_error: false },
          ],
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
    const result = await runSubprocessExecutor({
      prompt: 'p',
      cwd: '/tmp',
      config: baseConfig,
      spawn: makeFakeSpawn({ lines }),
      learningObserver: { observe: (i) => observed.push(i) },
    });
    // distinctToolNames also carries the verbatim unmapped name.
    expect(result.distinctToolNames).toEqual(['WebFetch']);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com', prompt: 'summarize' },
      status: 'success',
      traceId: 'tu_fetch',
    });
  });
});

describe('canonicalizeToolForObservation — pure name + input-key mapping', () => {
  test('Read → FileRead, file_path → path (other keys preserved verbatim)', () => {
    const { name, input } = canonicalizeToolForObservation('Read', {
      file_path: '/a/b.ts',
      offset: 10,
      limit: 5,
    });
    expect(name).toBe('FileRead');
    expect(input).toEqual({ path: '/a/b.ts', offset: 10, limit: 5 });
  });

  test('Write → FileWrite, file_path → path (content preserved)', () => {
    const { name, input } = canonicalizeToolForObservation('Write', {
      file_path: '/a/b.ts',
      content: 'hello',
    });
    expect(name).toBe('FileWrite');
    expect(input).toEqual({ path: '/a/b.ts', content: 'hello' });
  });

  test('Edit → FileEdit, file_path → path (old_string/new_string preserved)', () => {
    const { name, input } = canonicalizeToolForObservation('Edit', {
      file_path: '/a/b.ts',
      old_string: 'x',
      new_string: 'y',
      replace_all: true,
    });
    expect(name).toBe('FileEdit');
    expect(input).toEqual({ path: '/a/b.ts', old_string: 'x', new_string: 'y', replace_all: true });
  });

  test('Bash stays Bash but drops the Claude-only `description` noise field', () => {
    const { name, input } = canonicalizeToolForObservation('Bash', {
      command: 'ls -la',
      description: 'list files',
    });
    expect(name).toBe('Bash');
    expect(input).toEqual({ command: 'ls -la' });
  });

  test('Bash with only `command` is unchanged (no description to drop)', () => {
    const { name, input } = canonicalizeToolForObservation('Bash', { command: 'pwd' });
    expect(name).toBe('Bash');
    expect(input).toEqual({ command: 'pwd' });
  });

  test('Grep / Glob already match the native vocabulary — unchanged', () => {
    const grep = canonicalizeToolForObservation('Grep', { pattern: 'foo', path: 'src' });
    expect(grep.name).toBe('Grep');
    expect(grep.input).toEqual({ pattern: 'foo', path: 'src' });
    const glob = canonicalizeToolForObservation('Glob', { pattern: '**/*.ts' });
    expect(glob.name).toBe('Glob');
    expect(glob.input).toEqual({ pattern: '**/*.ts' });
  });

  test('an unmapped tool (WebFetch / Task / MCP) passes through unchanged', () => {
    const fetched = canonicalizeToolForObservation('WebFetch', { url: 'https://x', prompt: 'p' });
    expect(fetched.name).toBe('WebFetch');
    expect(fetched.input).toEqual({ url: 'https://x', prompt: 'p' });
    const mcp = canonicalizeToolForObservation('mcp__server__do_thing', { arg: 1 });
    expect(mcp.name).toBe('mcp__server__do_thing');
    expect(mcp.input).toEqual({ arg: 1 });
  });

  test('a Read that already uses `path` (no file_path) is left intact under FileRead', () => {
    // Defensive: if a future Claude build emits `path`, we must not clobber it.
    const { name, input } = canonicalizeToolForObservation('Read', { path: '/a/b.ts' });
    expect(name).toBe('FileRead');
    expect(input).toEqual({ path: '/a/b.ts' });
  });

  test('non-object input is passed through unchanged (only the name is mapped)', () => {
    // Robustness: tool_use.input is `unknown` from the stream.
    const nullCase = canonicalizeToolForObservation('Read', null);
    expect(nullCase.name).toBe('FileRead');
    expect(nullCase.input).toBeNull();
    const strCase = canonicalizeToolForObservation('Bash', 'not-an-object');
    expect(strCase.name).toBe('Bash');
    expect(strCase.input).toBe('not-an-object');
  });

  test('does not mutate the caller-provided input object (immutability)', () => {
    const original = { file_path: '/a/b.ts', limit: 5 };
    const { input } = canonicalizeToolForObservation('Read', original);
    // The returned input is a new object with the renamed key.
    expect(input).not.toBe(original);
    expect(input).toEqual({ path: '/a/b.ts', limit: 5 });
    // The original is untouched — still carries file_path, no path.
    expect(original).toEqual({ file_path: '/a/b.ts', limit: 5 });
  });
});
