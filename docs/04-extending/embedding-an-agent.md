# Embed an agent: lifecycle and host responsibilities

Use `@yevgetman/sov-sdk` for the reusable engine. Use the proprietary harness
or your own Kernel host to supply session operation, approval UI and deployment.
This guide describes SDK 0.12.0. It does not imply production readiness for every
combination of optional ports.

## Start with the public entry

The [SDK README](../../packages/sdk/README.md) contains a runnable offline
provider/tool quickstart. Start there, then replace the provider and inject only
the capabilities your host needs. Supported consumer code imports the package
entry. Deep subpaths ship for internal use and carry no stability guarantee.

```ts
import { createAgent, createInMemorySessionStore } from '@yevgetman/sov-sdk';
import type { LLMProvider, Message, RunResult } from '@yevgetman/sov-sdk';
```

The root `@yevgetman/sov` package and `src/main.ts` are the app, not the SDK.
Provider objects make testing deterministic. String providers resolve through
the SDK's provider configuration and credentials path. A bare SDK turn requires
no server or database; persistence is enabled by supplying a port.

## Own the session explicitly

`createAgent()` is reusable, but `run()` does not automatically load prior history.
A missing session id creates a new id. A repeated id with a string prompt alone
does not mean the SDK will remember the previous messages.

The host chooses an id, serializes writes for it, loads its stored history, appends
the new user message and calls `run(history, { sessionId })`. The default persistence
path requires a verbatim stored prefix to avoid re-appending old messages. Preserve
content blocks, including tool ids and signed thinking. Do not scrub or reorder
stored history in place. Repair incomplete tool/result pairs before inference.

SDK 0.12.0 also exposes `PerTurn.storedPrefixLength`. An advanced host can declare
the number of leading input messages already stored. This overrides JSON-prefix
deduplication; it is a host assertion, not a comparison against stored content.
Use it only while holding the session's single-writer lock and with a boundary
derived from the actual stored rows. An incorrect boundary can omit or duplicate
messages. Existing callers can keep verbatim rehydration.

The following recipe takes a text-only provider. A scripted provider that requests
a tool needs a matching tool pool and a compatible toolset. The host must serialize
calls to `turn` for this session. The in-memory store is for tests;
production storage must implement the same port and its own durable guarantees.

```ts
function sessionAgent(provider: LLMProvider) {
  const store = createInMemorySessionStore();
  const sessionId = 'embedding-example';
  const agent = createAgent({
    provider,
    model: 'echo-model',
    systemPrompt: 'Answer the user.',
    sessionStore: store,
    toolset: 'chat',
  });

  return async function turn(text: string): Promise<RunResult> {
    const history: Message[] = store.loadMessages(sessionId).map(row => ({
      role: row.role,
      content: row.content,
    }));
    history.push({ role: 'user', content: [{ type: 'text', text }] });
    const stream = agent.run(history, { sessionId });
    for (;;) {
      const step = await stream.next();
      if (step.done) return step.value;
      // Forward or record events here. Do not treat a text delta as completion.
    }
  };
}
```

Check `result.terminal.reason`. `max_tokens`, `max_turns`, `checkin`, `interrupted`
and `error` require explicit host handling. Persistence can throw outside an
in-band terminal; handle generator rejection as well. A text delta or a final
assistant event alone is not a durable successful turn.

## Keep capabilities and authorization separate

`chat` exposes no tools. `web` retains `WebSearch`/`WebFetch`. `ops` retains the
fixed operations names. `coding` retains the supplied pool. Toolsets never add a
tool. They are fixed name filters, not a custom hierarchy or an OS sandbox.

The host supplies a reviewed tool pool and `PerTurn.canUseTool` for authorization.
Omitting that callback does not install the harness's approval UI or rules stack.
Tool concurrency/read-only defaults do not amount to a default deny policy.
MCP tools, child tools, file tools and shell tools all need a policy appropriate
to their effects. See [SDK security guidance](../../packages/sdk/SECURITY.md).

An embedded host can use the exported scheduler, agent registry, lane semaphores
and path-lock manager. It must supply child session creation and provider
resolution. The scheduler defaults do not establish tree-wide budgets or a
distributed lock. Review child configuration explicitly; parent optional ports
are not all inherited. Some recursion rules are implemented by AgentTool and its
host context, rather than enforced solely by the scheduler interface.

## Plan context lifetime

The SDK performs microcompaction of selected old tool results. It protects the
current tool burst. It does not implement the gateway's full summary-compaction
and overflow retry path. Returning a `microcompact` event does not rewrite the
host's persisted transcript or supply a complete compacted history snapshot.

Until the proposed context port is implemented, the host must manage history
size, model limits, validated summaries and session transitions. Do not advertise
an indefinitely running session merely because `maxTurns` is large. A context
overflow cannot be fixed by repeatedly replaying the same oversized prompt.

## Cancellation, shutdown and observability

Pass an abort signal and make your own tools honor it. Dispose a generator you
stop consuming with `return()`/a `for await` break. The review found a provider
reader-cleanup defect and concurrent-work lifetime defect; track #10 and #14
before relying on cleanup as a production guarantee.

Give the host a bounded shutdown procedure: stop admission, abort turns, await
all started work, flush persistence/observers, and close owned resources. A child
deadline currently excludes lane/write-lock waiting (#12). Do not rely on it as
an absolute admission-to-completion deadline until that fix lands.

Use `RunResult.usage` and `estimatedCostUsd` for the parent run. Missing usage
means unknown, not zero. Scheduler child costs are not yet rolled into a parent
tree total. Trace run/session/parent/tool ids, queue time and terminal outcomes;
keep user text and secrets out of metrics. Budget paid live checks separately.

## Read next

- [SDK README](../../packages/sdk/README.md)
- [Consumer contract](../05-conventions/consumer-contract.md)
- [Production review](../07-history/audits/2026-10-09-sdk-production-review.md)
- [Proposed hardening design](../../specs/2026-10-09-sdk-production-hardening-design.md)
