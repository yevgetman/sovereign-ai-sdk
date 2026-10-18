// Stop aborts the host controller after the supervisor has stored its terminal.
// Check-in mode injects the standing limit the same way as sdk-run-checkin.ts.
import { mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentConfig, createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/index';
import type { LLMProvider, Transport } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';

const mode = process.argv[2] ?? 'completed';
if (mode === 'checkin') {
  const create = createAgent;
  mock.module('@yevgetman/sov-sdk/agent/createAgent', () => ({
    createAgent: (config: AgentConfig) => create({ ...config, maxToolCallsBeforeCheckin: 1 }),
  }));
}

const { runSdkRunCommand } = await import('../../src/cli/sdkRunCommand.js');
const { buildRuntime } = await import('../../src/server/runtime.js');
const { SessionDb } = await import('../../src/agent/sessionDb.js');

const RealAbortController = globalThis.AbortController;
const seen: AbortController[] = [];
globalThis.AbortController = class extends RealAbortController {
  constructor() {
    super();
    seen.push(this);
  }
};

const home = mkdtempSync(join(tmpdir(), 'committed-abort-'));
const dbPath = join(home, 'sessions.db');
const events: Record<string, unknown>[] = [];
let stops = 0;
let foundController = false;
const mark = { index: 0 };
const checkin = mode === 'checkin';
const provider: LLMProvider = {
  name: 'openai',
  async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
    if (mode === 'failed') {
      yield { type: 'message_start' };
      throw new Error('provider boom');
    }
    const message: AssistantMessage = checkin
      ? {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'checkin-effect', name: 'checkin_probe', input: {} }],
        }
      : { role: 'assistant', content: [{ type: 'text', text: 'kept answer' }] };
    yield { type: 'message_start' };
    yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
    if (!checkin) yield { type: 'text_delta', text: 'kept answer' };
    yield { type: 'message_stop', stop_reason: checkin ? 'tool_use' : 'end_turn' };
    yield { type: 'assistant_message', message };
    return message;
  },
};

try {
  mark.index = seen.length;
  const exit = await runSdkRunCommand(
    {
      json: true,
      stdin: true,
      route: 'openai-api',
      inputFormat: 'json',
      toolset: checkin ? 'coding' : 'chat',
    },
    {
      readStdin: async () => JSON.stringify({ inputVersion: 1, text: 'question' }),
      writeStdout: (line) => {
        events.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
    {
      resolve: async () => ({
        route: getRoute('openai-api', {}),
        model: 'gpt-4.1',
        effort: 'off',
        provider,
        resolved: {
          transport: provider as Transport,
          client: provider,
          baseUrl: 'mock://',
          model: 'gpt-4.1',
          contextLength: 200000,
          authType: 'api_key',
          metadata: { provider: 'openai', apiMode: 'openai', purpose: 'main' },
        },
      }),
      runtime: async (options) => {
        const runtime = await buildRuntime({
          ...options,
          harnessHome: home,
          dbPath,
          settings: {
            learning: {
              disabled: true,
              recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 },
            },
            review: { disabled: true },
          },
          cronEnabled: false,
        });
        runtime.loop = { mode: 'off' };
        if (checkin) {
          runtime.toolPool.splice(
            0,
            runtime.toolPool.length,
            buildTool<unknown, unknown>({
              name: 'checkin_probe',
              description: () => 'mock effect',
              inputSchema: z.unknown(),
              async call() {
                return { data: 'mock receipt' };
              },
            }),
          );
        }
        runtime.hookRunner = async (event) => {
          if (event === 'Stop') {
            stops += 1;
            const controller = seen[mark.index];
            if (controller) {
              foundController = true;
              if (mode === 'completed-user') controller.abort();
              else controller.abort('deadline');
            }
          }
          return { block: false };
        };
        return runtime;
      },
    },
  );
  const terminal = events.at(-1) ?? null;
  const db = SessionDb.open({ path: dbPath });
  const stored = db.loadLogicalTurn(String(terminal?.logicalTurnId));
  db.close();
  const controller = seen[mark.index];
  console.log(
    JSON.stringify({
      exit,
      stops,
      foundController,
      seen: seen.length,
      aborted: controller?.signal.aborted === true,
      reason: controller ? String(controller.signal.reason) : null,
      terminal,
      stored: stored
        ? {
            status: stored.status,
            finishReason: stored.finishReason ?? null,
            reply: stored.finalReply ?? '',
          }
        : null,
    }),
  );
} finally {
  globalThis.AbortController = RealAbortController;
  rmSync(home, { recursive: true, force: true });
}
