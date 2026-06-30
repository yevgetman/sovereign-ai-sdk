// examples/embed/embed.ts — the Task 8.1 external-style consumer canary.
//
// This is what an embedding host looks like: it imports the OPEN SDK from the
// barrel (`../../src/sdk.js`, the `./sdk` subpath in the Phase-8 exports map) and
// nothing else, wires a deterministic offline echo provider + one trivial tool,
// and runs a single turn to a final assistant message — with NO disk. It needs
// no API key (the provider is a scripted mock) and writes no files (the only
// SessionStore is the in-memory one), so it proves the open core is a genuine
// importable, no-disk surface that never pulls `bun:sqlite`.
//
// `tests/examples/embed.test.ts` drives `runEmbed()` and additionally asserts
// the SDK barrel's runtime dependency graph never reaches `bun:sqlite`.

import { z } from 'zod';
import { buildTool, createAgent, createInMemorySessionStore } from '../../src/sdk.js';
import type {
  AssistantMessage,
  LLMProvider,
  RunResult,
  StreamEvent,
  Tool,
} from '../../src/sdk.js';

/** The one user turn this canary runs. */
export const EMBED_QUESTION = 'echo this please';

/** The deterministic text the scripted provider ends the turn with. */
export const EMBED_FINAL_TEXT = `Echoed: ${EMBED_QUESTION}`;

/** A trivial tool: echoes its `text` input straight back. Wired into the agent
 *  so the canary exercises the full tool-dispatch path (no disk, no real I/O). */
const echoTool = buildTool({
  name: 'Echo',
  description: () => 'Echo the given text back to the caller.',
  inputSchema: z.object({ text: z.string() }),
  async call(input) {
    return { data: { echoed: input.text } };
  },
});

/** Build a fresh mock `LLMProvider` that replays one scripted turn per
 *  successive `stream()` call (generators are single-use). Turn 1 requests the
 *  Echo tool; turn 2 emits the final assistant text. No network, no key. */
function echoProvider(): LLMProvider {
  const toolUseTurn: StreamEvent[] = [
    { type: 'message_start' },
    { type: 'tool_use_delta', id: 't1', partial: `{"text":"${EMBED_QUESTION}"}` },
    { type: 'message_stop', stop_reason: 'tool_use' },
    {
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: EMBED_QUESTION } }],
      },
    },
  ];
  const finalTurn: StreamEvent[] = [
    { type: 'message_start' },
    { type: 'text_delta', text: EMBED_FINAL_TEXT },
    { type: 'usage_delta', usage: { inputTokens: 8, outputTokens: 4 } },
    { type: 'message_stop', stop_reason: 'end_turn' },
    {
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text: EMBED_FINAL_TEXT }] },
    },
  ];
  const queue: StreamEvent[][] = [toolUseTurn, finalTurn];
  return {
    name: 'echo',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = queue.shift();
      if (events === undefined) {
        throw new Error('echoProvider: no scripted turn left');
      }
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') {
          last = ev.message;
        }
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

/** Concatenate the text blocks of an assistant message. */
function assistantText(message: AssistantMessage | undefined): string {
  if (message === undefined) {
    return '';
  }
  return message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Run the embedded turn end-to-end and return the final assistant text plus the
 *  structured `RunResult`. Persistence is the IN-MEMORY store only, so the turn
 *  touches no disk regardless of `cwd`. */
export async function runEmbed(opts: { cwd?: string } = {}): Promise<{
  text: string;
  result: RunResult;
}> {
  const agent = createAgent({
    provider: echoProvider(),
    model: 'echo-model',
    systemPrompt: 'You echo what you are given.',
    maxTokens: 256,
    tools: [echoTool as unknown as Tool<unknown, unknown>],
    // In-memory: nothing is written to disk (no bun:sqlite SessionDb).
    sessionStore: createInMemorySessionStore(),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });

  const gen = agent.run(EMBED_QUESTION);
  let result: RunResult;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
  }
  return { text: assistantText(result.finalAssistant), result };
}

// Run directly (`bun examples/embed/embed.ts`) → print the final assistant text.
if (import.meta.main) {
  runEmbed()
    .then(({ text }) => {
      console.log(text);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
