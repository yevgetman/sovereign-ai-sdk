// Isolated SDK standing-limit injection: no production config addition/global mock.
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

const create = createAgent;
mock.module('@yevgetman/sov-sdk/agent/createAgent', () => ({
  createAgent: (config: AgentConfig) => create({ ...config, maxToolCallsBeforeCheckin: 1 }),
}));
const { runSdkRunCommand } = await import('../../src/cli/sdkRunCommand.js');
const { buildRuntime } = await import('../../src/server/runtime.js');
const { SessionDb } = await import('../../src/agent/sessionDb.js');
const home = mkdtempSync(join(tmpdir(), 'native-checkin-'));
const dbPath = join(home, 'sessions.db');
const events: Record<string, unknown>[] = [];
let effects = 0;
const provider: LLMProvider = {
  name: 'openai',
  async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'checkin-effect', name: 'checkin_probe', input: {} }],
    };
    yield { type: 'message_start' };
    yield { type: 'usage_delta', usage: { inputTokens: 3, outputTokens: 2 } };
    yield { type: 'message_stop', stop_reason: 'tool_use' };
    yield { type: 'assistant_message', message };
    return message;
  },
};
try {
  const exit = await runSdkRunCommand(
    { json: true, stdin: true, route: 'openai-api', inputFormat: 'json', toolset: 'coding' },
    {
      readStdin: async () => JSON.stringify({ inputVersion: 1, text: 'mock checkin request' }),
      writeStdout: (line) => {
        events.push(JSON.parse(line));
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
        runtime.toolPool.splice(
          0,
          runtime.toolPool.length,
          buildTool<unknown, unknown>({
            name: 'checkin_probe',
            description: () => 'mock effect',
            inputSchema: z.unknown(),
            async call() {
              effects++;
              return { data: 'mock receipt' };
            },
          }),
        );
        return runtime;
      },
    },
  );
  const terminal = events.at(-1);
  const db = SessionDb.open({ path: dbPath });
  const rows = db.loadMessages(String(terminal?.sessionId)).map((row) => row.role);
  db.close();
  console.log(JSON.stringify({ exit, events, effects, rows }));
} finally {
  rmSync(home, { recursive: true, force: true });
}
