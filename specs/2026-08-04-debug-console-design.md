# Debug Console for the SDK — Design Spec (v1)

**Date:** 2026-08-04
**Status:** DRAFT — awaiting CEO green-light (org:build-a-codebase step 2)
**Author:** Julie (COO, seated for the appleo node; this build lands in
`sovereign-ai-sdk` and is dogfooded back into Appleo)

## 0. Goal

Lift Appleo's in-app debug console into the SDK so **any** Sovereign AI SDK
implementation can switch it on cheaply: the same pill, the same draggable and
resizable panel, the same standalone tab, the same three tabs (Agent /
Telemetry / Data). The **Agent** tab ships complete — its data is the SDK's own
agent stream, which every host already has. **Telemetry** and **Data** ship as
*hookable surfaces*: the SDK renders and shapes them, the host supplies the
stream.

Then re-mount it in Appleo **from the SDK**, so Appleo's console is the
package's first consumer and behaves exactly as it does today.

## 1. The architectural fork — and why not React

Appleo's console is a React component. The SDK is a Node/agent library with no
UI and no React anywhere. Shipping React components from it would:

- add React as a peer dependency of an agent SDK,
- lock every consumer into one framework and one major version,
- and make "cheaply, with minimal setup" false for a Vue, Svelte, or plain-HTML
  host.

**So the console ships as a custom element, not a component** —
`<sov-debug-console>`, open shadow root, zero runtime dependencies, driven by an
injected adapter.

This is not a new invention: it is **exactly the shape assay's dashboard already
proved** (`<assay-dashboard>` + a `DashboardClient` adapter), which Appleo mounts
today with a `<script>` tag and two lines. That mount is the evidence the pattern
works across a framework boundary, and the same reasoning applies here.

A React wrapper for hosts that want one is a thin, optional extra — not the
package's shape.

## 2. What ships, and what hooks

| Tab | SDK provides | Host provides |
|---|---|---|
| **Agent** | everything — dispatch rows, tool calls *with inputs*, reasoning blocks, turn summaries (finish reason, tools, tokens, cost), session dividers, copy-to-clipboard | nothing (the SDK owns the agent stream) |
| **Telemetry** | the rendering, grouping, colouring, empty states | a stream of `TelemetryEvent` |
| **Data** | the rendering + the "mutations" framing | a stream of `DataEvent` |

The split is deliberate: agent machinery is universal, whereas "what is a
request" and "what is a data change" are the host's own vocabulary. Appleo's
answers (HTTP requests; git commits) are *one* host's, and hard-coding them
would make the console Appleo-shaped rather than SDK-shaped.

## 3. The adapter — one object, capability-probed

```ts
interface DebugConsoleAdapter {
  // The floor. Every SDK host can answer this.
  getAgentFeed(): Promise<AgentFeed>;

  // Capability-gated: ABSENCE HIDES THE TAB.
  getTelemetry?(): Promise<TelemetryEvent[]>;
  getData?(): Promise<DataEvent[]>;

  // Optional: the host reports a client-side navigation.
  reportEvent?(event: { name: string; detail?: string }): void;
}
```

Probed by `typeof adapter[method] === 'function'`, never invoked to test — the
same rule assay's element follows. **A host that supplies no telemetry adapter
sees a two-tab console**, not an empty tab claiming there is nothing to show.
That distinction is the difference between an honest surface and a broken one.

The SDK ships `createRestAdapter({ baseUrl })` for the common case (a host that
exposes the SDK's own debug routes), so the minimal mount is:

```html
<sov-debug-console></sov-debug-console>
<script src="/debug/assets/console.js"></script>
<script>
  document.querySelector('sov-debug-console').adapter =
    SovDebugConsole.createRestAdapter({ baseUrl: '/api/debug' });
</script>
```

## 4. The server half

The SDK also ships the **collector** — the piece Appleo built as `debug-log.ts`:
the per-account ring buffer, the replay-dedupe watermark, the bounded LRU, and
the turn-detail recorder that reads a gateway event stream. That is the part
with the hard-won details in it (tool-name/input pairing across `tool_use_start`
and `tool_use_done`, reasoning-block accumulation, the per-session watermark),
and re-deriving it per host is exactly what this extraction exists to prevent.

`createDebugCollector()` → `{ record, recordDetail, recordTelemetry, feedFor, … }`,
plus `debugRouteHandlers()` returning framework-agnostic handlers a host mounts
however it likes (Express, Fastify, Hono, a raw `http` server).

**The SDK does NOT ship an authorization model.** Appleo gates on a `debugger`
role and returns 404; another host will have its own answer. The SDK's handlers
take an `isPermitted(context) => Promise<boolean>` and refuse when it says no —
the *decision* is always the host's, and the docs state that mounting without
one publishes your agent's internals.

## 5. Dogfooding back into Appleo

Appleo then:
- deletes `web/src/debug/*` and mounts `<sov-debug-console>`;
- keeps its own role gate, its own 404 posture, its own telemetry and commit
  adapters (they are Appleo's vocabulary, per §2);
- replaces `src/agent/debug-log.ts` with the SDK collector.

**The acceptance test is behavioural, not structural: the console must look and
behave exactly as it does today** — same pill placement, drag, resize, `/debug`
tab, three tabs, tool inputs, reasoning rows, session dividers. Anything that
regresses is a portability gap in the extraction, and gets fixed in the SDK.

## 6. Work

1. `packages/debug-console/` — the element, the adapter contract, the REST
   adapter, the shadow-root stylesheet, an IIFE build.
2. `packages/sdk/src/debug/` — the collector + framework-agnostic route
   handlers, exported at `@yevgetman/sov-sdk/debug`.
3. Port the Agent tab verbatim (it is the proven surface); generalise Telemetry
   and Data behind the adapter.
4. Tests: element mounts with no adapter; tab hidden when its method is absent;
   collector replay-dedupe; tool input/name pairing; reasoning accumulation;
   REST adapter shapes.
5. Release the SDK, repin Appleo, delete Appleo's copies, verify parity in a
   browser against production.

## 7. Decisions for the CEO

1. **Custom element, not React** (§1) — the significant call. It is what makes
   "any implementation" true rather than "any React implementation", and it
   follows the assay dashboard's proven shape. Confirm.
2. **New package `@yevgetman/sov-debug-console`, or a subpath of the SDK?** My
   recommendation: a **separate package in the same repo**. The browser bundle
   has no business in a Node SDK's dependency graph, and assay's split
   (`assay/dashboard` vs `assay/dashboard-server`) exists for exactly this
   reason — it learned that the hard way when a browser-safe barrel accidentally
   pulled in `node:` imports.

## 8. Self-review

- **Reuses a proven pattern rather than inventing one**: the element+adapter
  shape is assay's, already mounted successfully by Appleo, including the
  capability-probe rule and the no-authentication-in-the-component stance.
- **The honest split (§2)** is the spec's load-bearing decision: shipping
  Appleo's HTTP-request and git-commit semantics as if they were universal would
  produce a console that only fits Appleo.
- **Weak point:** the Agent tab's richness depends on the gateway event
  vocabulary (`tool_use_start`/`tool_use_done`/`thinking_delta`). That is the
  SDK's own stream, so it is safe here — but a host running a *different*
  harness gets a thinner Agent tab, and the docs must say so rather than
  implying universality.
- **Scope honesty:** this is a multi-commit build across two repos ending in an
  SDK release and an Appleo repin. It is not a one-sitting change, and the
  parity check at the end is the part most likely to surface work.
