# @yevgetman/sov-debug-console

A framework-agnostic debug console for Sovereign AI SDK hosts: a floating pill
that opens a draggable, resizable panel showing what your agent actually did —
the model and lane per turn, tool calls **with their inputs**, reasoning blocks,
turn summaries, plus optional host-supplied telemetry and data changes.

It ships as a **custom element**, not a React component. The SDK has no UI and
no framework; making the console React-only would make "any implementation"
false for a Vue, Svelte, or plain-HTML host.

- Zero runtime dependencies. The IIFE bundle is ~14 KB and self-contained — no
  CDN, no font, no fetch on load.
- Open shadow root, themed through `--sdc-*` custom properties.
- Data arrives through one injected adapter. The element never fetches a path of
  its own choosing.

## Mount it

With a bundler:

```ts
import { defineDebugConsole, createRestAdapter } from '@yevgetman/sov-debug-console';

defineDebugConsole(); // registers <sov-debug-console>

const el = document.createElement('sov-debug-console');
el.adapter = createRestAdapter({ baseUrl: '/api/debug' });
document.body.append(el);
```

Without one — the `./iife` build registers itself:

```html
<sov-debug-console></sov-debug-console>
<script src="/debug/assets/sov-debug-console.iife.js"></script>
<script>
  document.querySelector('sov-debug-console').adapter =
    SovDebugConsole.createRestAdapter({ baseUrl: '/api/debug' });
</script>
```

## The adapter

```ts
interface DebugConsoleAdapter {
  getAgentFeed(): Promise<AgentFeed>;          // the floor — every SDK host has one
  getTelemetry?(): Promise<TelemetryEvent[]>;  // ABSENCE HIDES THE TAB
  getData?(): Promise<DataEvent[]>;            // ABSENCE HIDES THE TAB
  reportEvent?(e: { name: string; detail?: string }): void;
}
```

Capabilities are probed with `typeof adapter[method] === 'function'` and **never
by calling**. A host that supplies no telemetry adapter gets a two-tab console —
not an empty tab implying nothing happened. That distinction is the difference
between an honest surface and a broken one.

**Agent is the SDK's own stream, so it ships complete. Telemetry and Data are
your vocabulary** — "what is a request" and "what is a data change" differ per
application, so the console renders them and you supply them. One host's
answers are HTTP requests and git commits; yours may be job runs and row writes.

## Two things this component deliberately does not do

**It has no authentication.** No login, no token, no opinion about who may look.
Mount it behind whatever gate your host already uses for privileged views, and
gate the routes behind it too. *Mounting it unguarded publishes your agent's
internals* — the prompts, the tool inputs, the session ids.

**It never invents its stream.** The server half — the ring buffers, the
replay-dedupe watermark, the tool-name/input pairing across `tool_use_start` and
`tool_use_done` — lives in `@yevgetman/sov-sdk/debug`.

## Theming

Every colour and radius reads from a custom property, which inherits through the
shadow boundary:

```css
sov-debug-console {
  --sdc-bg: #ffffff;
  --sdc-ink: #111827;
  --sdc-accent: #2563eb;
}
```

`part="pill"`, `part="panel"` and `part="header"` are exposed for structural
overrides.

## A caveat worth stating

The Agent tab's richness depends on the gateway's event vocabulary
(`tool_use_start` / `tool_use_done` / thinking blocks). That is the Sovereign AI
SDK's own stream, so it is complete here — but a host running a **different**
harness that emits fewer event kinds gets a correspondingly thinner Agent tab.
It degrades honestly; it does not pretend.

## Development

```bash
bun test src/       # 19 tests: capability gating, escaping, resilience
bun run typecheck
bun run build       # ESM + the prebuilt IIFE
```
