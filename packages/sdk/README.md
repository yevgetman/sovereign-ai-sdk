# @yevgetman/sov-sdk

The open-core Sovereign AI SDK — an embeddable, provider-agnostic agent-loop
engine. `createAgent()` gives you a Claude-Code-style turn loop — streaming,
tool dispatch, sub-agent delegation, skills, MCP, hooks, and injectable
memory/recall and persistence ports — with **no disk, no server, and no
proprietary code** required for a bare turn.

Runs on **Node ≥ 20** and **Bun ≥ 1.2**.

## Install

```sh
npm install @yevgetman/sov-sdk   # Node
bun add @yevgetman/sov-sdk       # Bun
```

Tool input/output schemas are [zod](https://www.npmjs.com/package/zod) schemas.
`zod` is already a runtime dependency of this package, but if your own code
imports it (any project that authors tools does), declare it in your own
`dependencies` too.

## Quickstart

A complete, runnable single file: one tool, a scripted offline provider (no
network, no API key), in-memory persistence, and one streamed agent turn.
This is the same pattern as the repo's `examples/embed/embed.ts` canary.

```ts
// quickstart.ts — run with `bun quickstart.ts` (or compile with tsc for Node)
import { buildTool, createAgent, createInMemorySessionStore } from '@yevgetman/sov-sdk';
import type { AssistantMessage, LLMProvider, StreamEvent } from '@yevgetman/sov-sdk';
import { z } from 'zod';

// One tool: echoes its `text` input back.
const echoTool = buildTool({
  name: 'Echo',
  description: () => 'Echo the given text back to the caller.',
  inputSchema: z.object({ text: z.string() }),
  async call(input) {
    return { data: { echoed: input.text } };
  },
});

// A scripted offline LLMProvider: call 1 requests the Echo tool, call 2
// streams the final answer. Swap in a real provider (implement `stream()`)
// to talk to an actual model.
function echoProvider(): LLMProvider {
  const turns: StreamEvent[][] = [
    [
      { type: 'message_start' },
      { type: 'tool_use_delta', id: 't1', partial: '{"text":"hello"}' },
      { type: 'message_stop', stop_reason: 'tool_use' },
      {
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'hello' } }],
        },
      },
    ],
    [
      { type: 'message_start' },
      { type: 'text_delta', text: 'Echoed: hello' },
      { type: 'usage_delta', usage: { inputTokens: 8, outputTokens: 4 } },
      { type: 'message_stop', stop_reason: 'end_turn' },
      {
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Echoed: hello' }] },
      },
    ],
  ];
  return {
    name: 'echo',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      const events = turns.shift();
      if (events === undefined) throw new Error('no scripted turn left');
      let last: AssistantMessage | undefined;
      for (const ev of events) {
        if (ev.type === 'assistant_message') last = ev.message;
        yield ev;
      }
      return last ?? { role: 'assistant', content: [] };
    },
  };
}

const agent = createAgent({
  provider: echoProvider(),
  model: 'echo-model',
  systemPrompt: 'You echo what you are given.',
  maxTokens: 256,
  tools: [echoTool],
  // In-memory persistence: the turn touches no disk. Omit `sessionStore` for a
  // fully stateless turn, or implement the `SessionStore` port to own storage.
  sessionStore: createInMemorySessionStore(),
});

// run() streams every event through unchanged, then returns a RunResult.
const gen = agent.run('echo this please');
for (;;) {
  const step = await gen.next();
  if (step.done) {
    console.log(`\n[${step.value.terminal.reason}] tools used: ${step.value.distinctToolNames.join(', ')}`);
    break;
  }
  const ev = step.value;
  if ('type' in ev && ev.type === 'text_delta') process.stdout.write(ev.text);
}
```

Expected output:

```
Echoed: hello
[completed] tools used: Echo
```

## What's in the box

Everything below is exported from the package entry (`@yevgetman/sov-sdk`):

- **Agent loop** — `createAgent` (`Agent`, `AgentConfig`, `PerTurn`, `RunResult`),
  the lower-level `query()`, and the message/stream/terminal types.
- **Tools** — `buildTool`, the `Tool`/`ToolDef`/`ToolContext` shapes,
  `buildToolContext`, `buildToolScope`, canonical tool descriptors, and the
  permission types (`CanUseTool`, `PermissionResult`, …).
- **Providers** — `resolveProvider`, plus `LLMProvider`/`ProviderRequest` so you
  can implement your own provider.
- **Delegation** — `SubagentScheduler` and the narrow `Scheduler` port,
  `LaneSemaphores`, `PathLockManager`, and the executor port types.
- **MCP** — `buildMcpClientPool`, the `McpClientPoolFactory` port, and the
  server-config types (stdio / SSE / HTTP).
- **Hooks** — `buildHookRunner` plus the hook event/config/consent types.
- **Skills & slash commands** — `loadSkills`, `expandSkillPrompt`,
  `buildSkillCommands`.
- **Persistence & ports** — `createInMemorySessionStore` / the `SessionStore`
  port, the `TranscriptStore` port (+ no-op impl), and the injected port types
  for memory, recall, and observation (`MemoryRuntime`, `RecallResult`,
  `ObserveInput`, …). Implementations are yours to supply — the SDK defaults to
  no disk, no server, no learning unless a port is given.

## Public surface & versioning

- **The package entry (`@yevgetman/sov-sdk`) is the semver'd public API.** Its
  export names are frozen by a surface-snapshot test; removals/renames are
  breaking.
- **Deep subpaths (`@yevgetman/sov-sdk/*`) ship in the tarball but are
  internal and unstable** — they exist so the private wrapper and tests can
  reach every module, carry no semver coverage, and may change or disappear in
  any release.

Full policy: [`STABILITY.md`](../../STABILITY.md) at the repository root.

## Compatibility notes

- **A global `fetch` is required**, and every supported runtime provides one:
  Node ≥ 20 and Bun ≥ 1.2 both ship a global `fetch`, so no polyfill is needed
  and the "runtime without a global `fetch`" case cannot arise within the
  engines floor. The SDK does **not** currently expose a public `fetchImpl`
  injection point through `createAgent` or the package barrel — network-touching
  surfaces (the OpenAI-compatible provider, web tools, remote MCP) call the
  ambient global `fetch`. (A `fetchImpl` parameter exists only internally, as a
  test seam; it is not part of the public API.)
- **Bun consumers resolve the `bun` exports condition to the shipped
  TypeScript source** (`src/*.ts`) — no build step. Node consumers resolve
  compiled `dist/*.js` + `dist/*.d.ts`.
- The shipped artifact contains **no `bun:sqlite` and no proprietary imports**
  — enforced by a purity gate that runs against the installed tarball in CI.

## License

MIT.
