// End-to-end MCP wiring: real stdio MCP server (echo-server fixture) +
// real query() turn loop with a fake provider that scripts the agent's
// tool_use sequence. Verifies the complete path:
//   - server connects
//   - tool gets wrapped via wrapMcpTool
//   - assembleToolPool merges it with native tools + ToolSearchTool
//   - schemaSerialization emits the right schema for each
//   - orchestrator dispatches the MCP tool through the SDK
//   - tool_result content reaches the next turn

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { query } from '../../src/core/query.js';
import type { AssistantMessage, Message, StreamEvent } from '../../src/core/types.js';
import { buildMcpClientPool } from '../../src/mcp/client.js';
import { toToolSchemas } from '../../src/mcp/schemaSerialization.js';
import { wrapMcpTool } from '../../src/mcp/toolWrapper.js';
import type { McpClientPool } from '../../src/mcp/types.js';
import type { LLMProvider, ProviderRequest } from '../../src/providers/types.js';
import { assembleToolPool } from '../../src/tool/registry.js';
import type { ToolContext } from '../../src/tool/types.js';

const FIXTURE = join(__dirname, 'fixtures', 'echo-server.ts');

let pool: McpClientPool;

beforeAll(async () => {
  pool = await buildMcpClientPool({
    servers: { echo: { type: 'stdio', command: 'bun', args: [FIXTURE] } },
    log: () => {},
  });
});

afterAll(async () => {
  await pool.shutdown();
});

function scriptedTurns(turns: StreamEvent[][]): LLMProvider {
  const queue = [...turns];
  return {
    name: 'fake',
    async *stream(_req: ProviderRequest): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (!events) throw new Error('no more turns');
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') last = ev.message;
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

const completedAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'all done' }],
};
const completedEvents: StreamEvent[] = [
  { type: 'message_start' },
  { type: 'text_delta', text: 'all done' },
  { type: 'message_stop', stop_reason: 'end_turn' },
  { type: 'assistant_message', message: completedAnswer },
];

const ctx: ToolContext = {
  cwd: process.cwd(),
  sessionId: 'mcp-integration-test',
};

describe('MCP integration', () => {
  test('schemaSerialization marks the wrapped MCP tool as deferred', () => {
    const mcpTools = pool.tools().map((m) => wrapMcpTool(m, pool));
    const toolPool = assembleToolPool(ctx, { mcpTools });
    const schemas = toToolSchemas(toolPool);

    const echo = schemas.find((s) => s.name === 'mcp__echo__echo');
    expect(echo).toBeDefined();
    expect(echo?.description).toContain('ToolSearch');
    expect(echo?.input_schema).toEqual({ type: 'object', additionalProperties: true });

    const search = schemas.find((s) => s.name === 'ToolSearch');
    expect(search).toBeDefined();
    expect(search?.input_schema).toMatchObject({ type: 'object' });
  });

  test('end-to-end: agent calls ToolSearch, then the MCP tool, gets the result back', async () => {
    const mcpTools = pool.tools().map((m) => wrapMcpTool(m, pool));
    const toolPool = assembleToolPool(ctx, { mcpTools });

    const turn1ToolUse: AssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'search1',
          name: 'ToolSearch',
          input: { query: 'echo' },
        },
      ],
    };
    const turn2ToolUse: AssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'mcp1',
          name: 'mcp__echo__echo',
          input: { text: 'integration says hi' },
        },
      ],
    };

    const provider = scriptedTurns([
      [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'tool_use' },
        { type: 'assistant_message', message: turn1ToolUse },
      ],
      [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'tool_use' },
        { type: 'assistant_message', message: turn2ToolUse },
      ],
      completedEvents,
    ]);

    const gen = query({
      provider,
      model: 'fake',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      maxTokens: 256,
      tools: toolPool,
      toolContext: ctx,
    });

    const yielded: (StreamEvent | Message)[] = [];
    let terminal: { reason: string } | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      yielded.push(step.value);
    }
    expect(terminal?.reason).toBe('completed');

    const toolResultMessages = yielded.filter(
      (m): m is Message => typeof m === 'object' && 'role' in m && m.role === 'user',
    );

    // Turn 1: ToolSearch result mentions the echo tool's full schema.
    const searchResult = toolResultMessages[0]?.content[0];
    if (searchResult?.type !== 'tool_result') throw new Error('expected tool_result for search');
    expect(searchResult.content).toContain('mcp__echo__echo');
    expect(searchResult.content).toContain('"text"');

    // Turn 2: the actual MCP call returned the input verbatim. With the
    // Phase 12.5 envelope, the content gains a status/summary header above
    // the original verbatim text.
    const echoResult = toolResultMessages[1]?.content[0];
    if (echoResult?.type !== 'tool_result') throw new Error('expected tool_result for echo');
    expect(echoResult.content).toContain('status: success');
    expect(echoResult.content).toContain('integration says hi');
    expect(echoResult.is_error).toBeUndefined();
  });

  test('isError from the MCP server is surfaced on the tool_result', async () => {
    const mcpTools = pool.tools().map((m) => wrapMcpTool(m, pool));
    const toolPool = assembleToolPool(ctx, { mcpTools });

    const boomCall: AssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'b1',
          name: 'mcp__echo__boom',
          input: {},
        },
      ],
    };

    const provider = scriptedTurns([
      [
        { type: 'message_start' },
        { type: 'message_stop', stop_reason: 'tool_use' },
        { type: 'assistant_message', message: boomCall },
      ],
      completedEvents,
    ]);

    const gen = query({
      provider,
      model: 'fake',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: [],
      maxTokens: 256,
      tools: toolPool,
      toolContext: ctx,
    });

    const yielded: (StreamEvent | Message)[] = [];
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
      yielded.push(step.value);
    }

    const userMsg = yielded.find(
      (m): m is Message => typeof m === 'object' && 'role' in m && m.role === 'user',
    );
    const block = userMsg?.content[0];
    if (block?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(block.is_error).toBe(true);
    expect(block.content).toContain('something went wrong');
  });
});
