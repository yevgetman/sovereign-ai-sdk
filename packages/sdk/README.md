# @yevgetman/sov-sdk

The open-core Sovereign AI SDK — an embeddable, provider-agnostic agent-loop
engine. `createAgent()` gives you a Claude-Code-style turn loop — streaming,
tool dispatch, sub-agent delegation, skills, MCP, hooks, and injectable
memory/recall and persistence ports — with **no disk, no server, and no
proprietary code** required for a bare turn.

Runs on **Node ≥ 20.19** and **Bun ≥ 1.2**.

## Install

SDK **0.13.0** is published as a tarball in [SOV v0.6.76](https://github.com/yevgetman/sov-releases/releases/tag/v0.6.76), with `SDK-SHA256SUMS`. Download both assets, verify the checksum, then install the local tarball:

```sh
shasum -a 256 -c SDK-SHA256SUMS
npm install ./yevgetman-sov-sdk-0.13.0.tgz   # Node
# Or:
bun add ./yevgetman-sov-sdk-0.13.0.tgz       # Bun
```

For repeatable builds, vendor the verified file and commit the dependency lockfile.
This release does not establish npm-registry publication. Registry publication is a
separate owner gate in [PUBLISHING.md](../../PUBLISHING.md). Installing the SOV binary
installs the application, not this library.

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
  can implement your own provider, and `RouterProvider` (+ `RouterProviderConfig`,
  `ResolvedRoute`) — the generic model-router lane (ask for model `auto`; a router
  picks the upstream, reporting it back via `onRouteResolved`). See
  [`docs/04-extending/routing-an-agent.md`](https://github.com/yevgetman/sovereign-ai-sdk/blob/master/docs/04-extending/routing-an-agent.md).
- **Delegation** — `SubagentScheduler` and the narrow `Scheduler` port,
  `LaneSemaphores`, `PathLockManager`, and the executor port types.
  A child reservation is released on every completion or setup failure, including a
  throwing host lane resolver. Failed setup does not consume the parent's child cap.
  Child wall-clock deadlines include lane and write-lock queue time. Queue expiry
  rejects delegation before a child session or provider starts. Parent cancellation
  uses the same signal through queues and child execution.
  Native children report optional `usage`, `usageStatus` (`complete`, `partial`, or
  `unknown`), and optional `estimatedCostUsd`. Missing usage or unknown pricing is
  not a zero-cost run. Trajectory cost metadata is likewise optional.
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
- **Deep module paths ship in the tarball but are
  internal and unstable** — they exist so the private wrapper and tests can
  reach every module, carry no semver coverage, and may change or disappear in
  any release.

Full policy: [`STABILITY.md`](https://github.com/yevgetman/sovereign-ai-sdk/blob/master/STABILITY.md) at the repository root.

## Compatibility notes

- **A global `fetch` is required**, and every supported runtime provides one:
  Node ≥ 20.19 and Bun ≥ 1.2 both ship a global `fetch`, so no polyfill is needed
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

### Host-supplied context reduction

Configure optional `contextManager: ContextManagementPort` and `contextLimits`
on `createAgent()` or its per-turn overrides. `maxHistoryBytes` is the UTF-8 JSON
history envelope, excluding system/tools; optional `contextWindowTokens` is a
host model-limit hint. There is no bundled summary engine. Native child policy
can explicitly inherit the same configuration.

Supply an exact `modelMetadata: ModelRecord` snapshot to `createAgent()`, a
per-turn override or `query()` to budget from discovery. The agent clones it at
turn start. Fresh context/output maxima are constrained by host
`contextLimits.contextWindowTokens` and `maxTokens`; host settings never expand a
provider maximum. Unknown values fall back to 32,768 context tokens and 8,192
output tokens. Stale metadata may tighten these limits but cannot expand them.
`contextLengthFor(provider, model, metadata, hostCap)` resolves the same context
limit for hosts doing proactive compaction. Its two-argument legacy form retains
the historical registry behavior.

The loop checks system, tools and history with an output reservation before every
provider call, including resumed history and later tool results. It invokes only
a supplied context reducer; otherwise an oversized request fails with intact
history. Provider-request traces record effective limits and metadata source.
Anthropic thinking cannot raise a metadata or host-budgeted output cap after the check.

The default input estimate is conservative UTF-8 JSON bytes plus framing. It is
not a provider tokenizer or a verified image-patch counter. Supply pure,
model-aware `inputTokenCounter(request)` for verified accounting, including system,
tools and multimodal framing. Provider overflow recovery remains authoritative
when an estimate is insufficient. Custom providers with neither metadata nor a
host token-window cap retain legacy behavior; use a snapshot to opt into the new
conservative unknown policy. No discovery fetch or disk write occurs in the loop.

The port receives a history snapshot, reason (`budget` or `overflow`), model,
provider, output token cap and `AbortSignal`. It returns reduced `messages` and
optional summary-engine `usage`/`estimatedCostUsd`. A replacement must shrink,
retain the final message verbatim and keep each complete tool call adjacent to
its matching user results. When the final message contains tool results, retain
its preceding assistant tool call too. Empty, inflated and malformed replacements
fail closed. Full persisted transcripts remain unchanged by context reduction.

`maxOverflowRetries` supports zero or one (default one). Recovery occurs only
before provider output and tool dispatch. It never replays external effects.
The host port must honor cancellation and settle; the SDK awaits it rather than
leaving it running in the background.

The content-free `context_management` event reports byte counts, reason,
`applied` status and supplied summary usage/cost. Rejected summaries still count
trusted billing metadata. Summary usage is added separately from provider usage;
summary cost is priced by the host, never at the main model's rate. Missing or partial
summary usage sets `RunResult.usageComplete` false. Unknown summary cost leaves
aggregate `estimatedCostUsd` absent. In that case the legacy numeric-cost store
cannot represent the aggregate: its token/cost write is skipped. Hosts must use
the returned usage/events for unpriced accounting; transcript writes still occur.

`SessionStore.truncateMessages` is optional for legacy stores. Ordinary runs
remain supported. Conduct regeneration that must undo persisted writes fails
with `RegenerationRollbackUnavailableError` before replay when that capability
is absent. Built-in `InMemorySessionStore` retains its required rollback method.

### Tool batch lifecycle

Each dispatched tool call produces one ordered result. Exceptions in permission
callbacks, hooks, input validation, result rendering, or tool execution become an
error on that tool's result. A failure after execution retains the available tool
output alongside the dispatch error. A failing custom output renderer retains
the raw receipt and valid supplementary messages; unserializable output retains
a completed-tool marker. Other tools keep their actual results.
Started concurrent tools are joined before the batch yields or the turn returns,
including during cancellation. Cancellation prevents further execution once it
is observed; hosts must provide tools that honor the signal for prompt shutdown.
The SDK waits for an already started tool even if it ignores cancellation.
Host callback failures after dispatch preserve the completed results in history.

Host callback failures stay contained even when error messages cannot be converted
to text. A renderer must return string content; invalid content uses the raw
completed receipt fallback and an error result. Failure reporting does not let a
concurrent dispatch return before its started siblings settle.
OpenAI-compatible streaming transports cancel unfinished response bodies when a consumer
stops reading or receives `[DONE]`. Reader locks are released on EOF, abort, and errors;
cleanup failures do not replace the original outcome.

OpenAI-compatible responses require an explicit successful `finish_reason` (`stop`,
`length`, or `tool_calls`/legacy `function_call`). A `[DONE]` marker alone does not
prove the answer completed. Empty/truncated responses, invalid completion chunks,
malformed JSON data frames (including a partial trailing data line), invalid UTF-8,
explicit provider error envelopes, invalid reasoning channel types,
and malformed or incomplete tool calls throw `ProviderStreamError` (available from
the `providers/errors` subpath of `@yevgetman/sov-sdk`). Partial deltas can remain
visible, but no
completed assistant message or executable tool call is emitted for these failures.
`createAgent()` ends with terminal reason `error`; it does not replay the response.
Engine-supplied tool IDs are preserved. If a compatible backend omits an ID, the
transport generates a unique ID for that call so later tool rounds retain distinct
identities in the transcript and provider history. Explicit duplicate IDs within
a response are rejected.

### Optional host session ownership

`SessionWorkQueue` serializes callbacks for each session while admitting bounded
parallel sessions. Its explicit `maxActiveSessions`, `maxQueued`, and
`maxQueuedPerSession` limits prevent unbounded waiting work. Run the full agent
and await its persistence inside `queue.submit(sessionId, callback, signal)`.
Load persisted history inside that callback after ownership is acquired.
`queue.shutdown()` closes admission, cancels queued work and signals active work;
shutdown joins all started callbacks. `shutdown(false)` preserves active work.
A callback must await all its own tasks; uncooperative work keeps shutdown pending.
This helper is memory-only and optional. All writers must share one instance.
It provides no cross-process lease, durable queue, automatic replay or
exactly-once external effects. `SessionWorkQueueError.code` identifies admission
and cancellation failures. `snapshot()` reports counts without owner content.

A context reduction can return a known cost without token usage. If it fails or
is cancelled before main-provider work starts, `RunResult.estimatedCostUsd`
retains that charge; `usage` stays absent and `usageComplete` is false. The
numeric token-usage store cannot represent unknown tokens, so this cost-only
case skips its aggregate write. Hosts can retain the context event's cost in
their own billing store.

When a reduction contributes usage, each main-provider call must finish with
input and output usage, and its provider/model must have a built-in price, before
the combined cost is known. An unknown main bill
sets `usageComplete` false and skips the combined numeric billing write; observed
tokens remain in the result. This rule covers context aggregation.

## Capability profiles and native child policy

`CapabilityProfileRegistry` adds host-named profiles to the compatible `chat`,
`web`, `ops`, and `coding` toolsets. A custom profile lists canonical tool names,
including external/MCP names explicitly. It filters the supplied pool; it does
not create tools or grant permission. Pass it as `AgentConfig.capabilityProfiles`
and select it with `toolset`, or put it on a scheduler `ChildPolicy`.

The scheduler's optional `childPolicy` carries `inheritedConfig`: parent hooks,
recall, observation, Conduct governance, context-management ports, reasoning and
other agent settings. This configuration excludes provider/model, tools, caps,
and persistence; the child owns those. Hosts must bind the policy from the
parent's effective configuration. It is not inferred from a parent agent handle.
The child context carries the policy, depth, narrowed tool pool and permission
boundary to further delegations. Model-selected definitions may select a narrower
`capabilityProfile`; they cannot restore tools absent from the parent pool.
Allow-list patterns are enforced by the existing tool permission matcher.
Malformed patterns fail before a child session starts. A child authorization
policy receives an isolated copy. Noncloneable inputs fail closed. A narrowing
policy can deny but cannot override a parent denial or rewrite parent-authorized
inputs. Native policy cannot be enforced by a subprocess executor, so that
combination rejects delegation.

## Shared tree budgets

Create one `TreeBudget` per host-controlled tree. Optional limits are `maxDepth`,
`maxTotalChildren` (all reservation attempts, including failed setup),
`maxConcurrentChildren` (including queued children), `maxTotalTokens`, and
`maxEstimatedCostUsd`. Native children share it through `ChildPolicy.treeBudget`.
Depth starts at one for a first child. Child reservations are atomic and release
active counts exactly once; cumulative counts are not refunded.

Token/cost limits require an explicit `estimateRequestBudget(request)` host
callback with a conservative per-request upper bound. It must include input,
cache and output tokens; its token bound must cover `request.maxTokens`.
A cost limit also requires a cost bound. Do not substitute a rough text-length
guess for a proven ceiling. Invalid or unavailable bounds reject before provider
work. Unknown or partial provider usage conservatively consumes the reserved
bound and increments `unknownRequests`; unknown model pricing never frees a cost
reservation as zero. Reported bound violations exhaust the budget and stop later
requests. Reasoning tokens are a subset of output and are not added twice.

`budgetProvider(provider, budget, estimateRequestBudget)` applies the same contract
to the parent or a context manager's provider. Use the same budget object for
parent, child, retry and summarization calls to cover the entire tree. The SDK
cannot account a provider that the host calls outside this wrapper. Native child
providers are wrapped once by the scheduler; do not wrap them a second time.
Failed, cancelled, or incompletely closed calls retain the reserved ceiling and
any larger observed token lower bound. Observed usage is not discarded when the
completion marker is missing. Host settlement can pass `false` as the third
argument to `reserveRequest()`'s returned callback to mark usage incomplete.

`budget.snapshot()` exposes accounted tokens, estimated cost, unknown requests,
child counts, completeness flags and exhaustion. Unknown accounting remains an
upper bound; `estimatedCostComplete: false` must never be reported as free work.

These are in-process admission controls. A trusted provider/host estimator must
honor its declared ceiling; the SDK cannot undo an external charge that exceeds
it. Cost figures are estimates, not billed amounts. Wall-clock limits remain
child delegation deadlines; a whole-tree deadline is the host's cancellation
signal. Distributed leases, durable meters and OS sandboxing remain host duties.

Read next: [Production review](https://github.com/yevgetman/sovereign-ai-sdk/issues/15),
[Consumer contract](https://github.com/yevgetman/sovereign-ai-sdk/blob/master/docs/05-conventions/consumer-contract.md).

### Portable model discovery

`createModelDiscovery()` provides offline `read(source)` and explicit
`refresh(source)` operations. The default cache is memory only. Inject fetch,
clock and cache ports to suit the host. Version-1 model records keep exact IDs,
authentication routes, authors, hosts, unknown capabilities and stale metadata
separate. Public catalogs do not prove account entitlement. See
[src/providers/models/README.md](src/providers/models/README.md) for the contract
and migration rules. Existing `listRoutes()` remains offline.
### Model capabilities and modalities

Selected `ModelRecord` metadata distinguishes `supported`, `unsupported` and
`unknown` capability. `validateModelRequest(request, providerName, record)` checks
actual inputs and replayed history, including images, tool calls and tool
results. Known-incompatible required images or tools fail with safe `unsupported_input`
errors. Unknown OpenRouter capabilities are refused; direct/local compatibility
rules are described below. Bundled suggestions
preserve existing tool/image behavior without certifying unknown capability.
Explicit unsupported capability is always refused. Text-only, no-tool
requests do not require those capabilities. A known restricted `toolChoices`
list also fences tool-choice formats. Metadata must match both the selected
provider and exact model ID.

Serializer support is separate from model support. Direct xAI's
OpenAI-compatible image and function-call body is fixture-tested against the
[published chat contract](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions).
Subscription image paths remain fenced. Route image flags describe serialization,
not universal model vision. Local Ollama/SOV/Manifest image paths retain their serializer behavior.
Injected providers own their serializer contract. Without supplied model
metadata, existing custom provider behavior is retained; hosts must use discovered metadata to certify
capability. No fixture certifies an account entitlement or a paid live request.

Direct Anthropic/OpenAI/xAI API model lists often contain IDs without tool
metadata. Unknown tools preserve the existing function-serializer attempt for
both established and new IDs. Provider refusal is retained; this is not model
support or account entitlement certification. Unknown images retain only exact
established native choices, while explicit unsupported capabilities always fail.
OpenRouter discovered unknown required capabilities are refused because model
and inference-host support differ. Text-only/no-tool requests remain valid.
A host can inject a `ModelRecord` through `createAgent({ modelMetadata: record })`
to supply verified capability facts for a new model. Set its exact provider,
route, model ID and a truthful `metadata.source`; for example a verified vision
contract can explicitly set `record.capabilities.images = 'supported'`. This
changes request validation only, and does not grant authentication or trigger
fallbacks. Custom/local providers own their serializer contracts.
### Model pricing snapshots

`estimateUsageCost(provider, model, usage, snapshot?)` returns an estimate with
`complete`, a paid/free/subscription/unknown state, source, rates and pricing time.
Unknown pricing omits `amountUsd`; token usage is retained. Inject a normalized
`PricingSnapshot` through `createAgent` or a per-turn override. Reasoning tokens
are already part of output tokens. Rates are per million tokens in USD.

The deprecated numeric `estimateCostUsd` now returns `number | undefined`. Check
for an unknown value; never coerce it to zero in billing or displays. This is a
source migration for numeric-only callers and must be included in an SDK minor
release. Stores can implement additive `recordUsageEstimate` to retain immutable
receipts, including unknown usage. Legacy stores receive only known numeric
estimates; unknown usage remains available in `RunResult`. SOV's SQLite store
records receipts and marks mixed/unknown session estimates incomplete. Its
numeric counters are known subtotals, never a complete bill when that flag is false.

Agent usage covers its own provider calls plus reported context components. It does
not include a complete delegated-child bill. Aggregate receipts identify host context
estimates separately. SOV stores auxiliary-compaction receipts separately from main
token counters. Historical rows without reliable pricing evidence are marked incomplete.

Tree-budget settlement captures model identity and prices before host callbacks or provider awaits. Explicit model metadata without verified prices keeps the host’s reserved cost upper bound and marks the cost incomplete. Metadata-absent calls retain established built-in pricing.

### OpenRouter execution policy

Use `settings.providers.openrouter.routing` with `createAgent`, or pass
`openrouterPolicy` when constructing `OpenAIProvider` directly. The optional
policy supports `order`, `only`, `ignore`, `allow_fallbacks`,
`require_parameters`, `data_collection`, `zdr`, `enforce_distillable_text`, and
`sort` (`price`, `throughput`, `latency`). Fields use OpenRouter's wire names.
For a strict host pin, set `only: ['host/endpoint']` and
`allow_fallbacks: false`. `order` alone expresses a preference. Endpoint names
are not a frozen SDK allowlist. Invalid and contradictory policies fail before
inference. Only the OpenRouter transport accepts these fields; omitted policy
keeps existing router defaults. If no allowed endpoint is available, the call
fails without broadening the policy. Model-author prefixes identify the model,
not the selected inference host. This adapter does not infer or certify the
actual host; absent response evidence it remains unknown.

Policy field definitions follow the [OpenRouter provider routing contract](https://openrouter.ai/docs/guides/routing/provider-selection).

Hosts that use `SubagentScheduler` can inject
`resolveModelMetadata(provider, model): ModelRecord | undefined` to provide one
model-bound snapshot for each resolved child. The scheduler clones the record,
passes it to the child agent and derives child pricing from that same record.
Parent model metadata and prices are not inherited by a different child.
The callback is host-owned; the SDK adds no disk, network or credential lookup.
A SOV host uses its node-scoped catalog cache. A custom SDK host can use an
in-memory catalog or supply its own verified metadata.

`maxTokens` is an output ceiling. Each provider call can reserve fewer output
tokens when the conservative input bound leaves less room in the effective
context window. The actual request cap and trace reservation agree. Standing
instructions and request history are not truncated. Input that fills the window
still needs an authorized context reducer or fails before inference. A
reasoning adapter that requires a larger minimum reservation still refuses an
insufficient cap before contacting the provider.
