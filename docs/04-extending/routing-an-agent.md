# Routing An Agent Through A Model Router

The SDK does not embed model-routing logic — it connects to a dedicated routing proxy and lets that proxy pick the upstream. This recipe covers the **`manifest` lane**: the caller stops choosing a model, asks for `"auto"`, and the router decides the upstream by cost, capability, locality, subscription-vs-API, and fallbacks. **Manifest is the current, official router solution** (adopted 2026-07-06); the lane itself is generic.

> **No new concept in the SDK.** The router lane is an OpenAI-compatible transport (`RouterProvider`, apiMode `'router'`) that subclasses the existing OpenAI provider and overrides only two seams: a static `headers` map for routing hints, and an `onRouteResolved` callback that surfaces what the router did. **Nothing from Manifest is imported** — the coupling is only the OpenAI wire plus the pinned `X-Manifest-*` header names. Swapping routers later is a `baseURL` override or a new registry entry on the same class; the SDK stays router-agnostic.

## What the lane is

The Factory's **model-router organ** (`~/code/me/projects/model-router.md`) is a provider-agnostic router the SDK *connects to* but does not contain. The adopt-vs-build decision resolved to adopt [Manifest](https://github.com/mnfst/manifest) as the current binding, keeping the SDK seam generic (the same protocol-marriage posture as the [Assay wire](metering-an-agent.md#metering-with-assay-the-official-pairing)). Concretely:

- **Provider name:** `manifest` — a registry lane whose apiMode is `'router'`.
- **Default model:** `auto` — the routing alias. Manifest resolves it per request.
- **Default base URL:** `http://localhost:2099/v1` — a self-hosted Manifest instance on loopback.
- **Auth:** required. `Authorization: Bearer mnfst_<key>`, from `MANIFEST_API_KEY`.

## Setting up Manifest

Manifest ships as a self-hosted Docker service with an `install.sh` one-liner — run it per [Manifest's self-hosted docs](https://manifest.build/docs) and it comes up on `http://localhost:2099`.

1. Open the dashboard, create the **first account** — it becomes the admin.
2. Go to **Agents** and mint an agent key (an `mnfst_...` bearer token).
3. Export it where the harness will read it:

```sh
export MANIFEST_API_KEY=mnfst_...
```

That is the only machine-state step. Installing/operating Manifest is an interactive action staged for the operator; the SDK proves the lane against scripted fetches plus an env-gated live probe (below).

## Using it from the harness

Point any surface at the lane by name — no code:

```sh
sov --provider manifest            # ask the router to choose (model defaults to `auto`)
```

Or set it as the standing default (config, or `/config` → Providers → **Manifest (model router)**):

```json
{
  "defaultProvider": "manifest",
  "providers": {
    "manifest": {
      "baseUrl": "http://localhost:2099/v1",
      "model": "auto"
    }
  }
}
```

**Pinning a real model id restores exact context-length lookup.** With `model: "auto"` the routed upstream is unknown, so the lane advertises a **conservative 128k context floor** for compaction math. If you pin `providers.manifest.model` to a known model id, the SDK looks up that model's real context length instead of the floor.

## Routing hints

Manifest routes by request complexity/specificity and by **custom tier headers** — user-defined key/value pairs you configure when creating a tier in Manifest. The lane carries them as a static `headers` map (config-file-only in v1 — there is no CLI flag for headers):

```json
{
  "providers": {
    "manifest": {
      "model": "auto",
      "headers": {
        "x-tier": "cheap",
        "x-session-key": "my-cli-session"
      }
    }
  }
}
```

`headers` exists **only** on this lane (it is a parse error on any other provider). Routing-hint headers are merged **first**, then the transport's real content-type and `Authorization` are applied on top — a hint header can never mask the real auth.

**`x-session-key` and the static-key semantics.** `x-session-key` groups requests for sticky-upstream selection and prompt caching. Because a transport is session-agnostic in v1, one key per process = **one Manifest session** for the process's lifetime — which is fine and cache-friendly for a single-user CLI. Threading a per-session key onto the wire (so each harness session gets its own sticky key) is a core-type change and a **named follow-up**, not v1.

## Embedding it (route reporting)

`createAgent` accepts a provider as either a **name string** (resolved via `resolveProvider`) or a **concrete `LLMProvider` instance**. `resolveProvider` can wire the lane from config but **cannot thread the `onRouteResolved` callback** — so to observe the resolved route, an embedder constructs `RouterProvider` directly and passes the instance:

```ts
import { createAgent, RouterProvider, type ResolvedRoute } from '@yevgetman/sov-sdk';

let lastRoute: ResolvedRoute | undefined;

const router = new RouterProvider({
  apiKey: process.env.MANIFEST_API_KEY!,         // the mnfst_ agent key (required)
  // baseURL: 'http://localhost:2099/v1',        // default — self-hosted Manifest
  headers: { 'x-session-key': 'my-embed-session' },
  onRouteResolved: (route) => {
    lastRoute = route;                            // { model?, provider?, tier?, reason? }
  },
});

const agent = createAgent({
  provider: router,   // a concrete LLMProvider instance, not a name string
  model: 'auto',      // ask the router to choose
  systemPrompt: 'You are a helpful assistant.',
  maxTokens: 12_000,
});

// run() returns an AsyncGenerator — drain it to terminal (the README quickstart pattern).
const gen = agent.run('summarize this file');
let step = await gen.next();
while (!step.done) step = await gen.next();

console.log(`[${step.value.terminal.reason}]`);
if (lastRoute !== undefined) {
  console.log(`routed to ${lastRoute.provider ?? '?'} / ${lastRoute.model ?? '?'}`);
}
```

Surfaces that only accept a **name string** (`defaultProvider: "manifest"`, the CLI, `resolveProvider`) still route through Manifest — they just don't receive the `onRouteResolved` thread. Route reporting is an embedder capability.

## Route visibility

Manifest reports what it actually did in response headers — `X-Manifest-Model`, `X-Manifest-Provider`, `X-Manifest-Tier`, `X-Manifest-Reason`. The lane parses them and, **when any is present**, hands a `ResolvedRoute` (every field optional; an absent header ⇒ an absent field) to `onRouteResolved`.

This is **best-effort**: no header present ⇒ the callback is not invoked, and a **throwing callback is swallowed** so it can never break the turn (the `traceRecorder` posture). A proxy deployment may strip the headers entirely — treat a reported route as a diagnostic, not a contract.

## Honest caveats

- **`/effort` is a no-op on this lane.** With `model: "auto"` the routed upstream is unknown, so sending a reasoning/effort param could error on a non-reasoning upstream. `modelSupportsReasoning(_, 'router')` returns `false` (the same honest gate as ollama) — no thinking param is ever attached. Revisit if routers grow a reasoning-passthrough contract.
- **Conservative 128k context floor.** As above — the compaction math needs *a* number for an unknown upstream. Pin a real model id to get exact context lookup.
- **Cost accounting prices the alias, not the routed model.** With `model: "auto"`, the SDK's in-process `estimateCostUsd` and the [Assay usage wire](metering-an-agent.md#metering-with-assay-the-official-pairing) price the **alias** `auto`, not whatever upstream Manifest actually chose. On this lane, **Manifest's own spend tracking is authoritative.** Surfacing the routed-model usage (from `onRouteResolved`) into the Assay wire is a **named follow-up**, not v1.
- **Fallback is pre-first-chunk.** Manifest applies its fallback chain **before** the first streamed chunk; a **mid-stream failure closes without retry**. Don't assume a fallback rescues a stream that already started.
- **Rate limits and exhaustion.** `429` = the agent's request-rate limit (Manifest default 100 req / 60 s, configurable when self-hosted); `424` = the fallback chain was exhausted. These propagate as upstream errors — the SDK does not duplicate Manifest's limits/alerts.
- **Sovereignty.** The default endpoint is **loopback self-hosted Manifest** — nothing calls out unless you point `baseUrl` at the cloud. But prompts flow **through** the router by definition (it is the request path); self-hosting keeps them on-box.

## Testing the lane against a live router

`tests/providers/router.live.test.ts` is an env-gated conformance probe (the `sov.live.test.ts` pattern): it **skips cleanly** unless both `MANIFEST_LIVE=1` and `MANIFEST_API_KEY` are set. It streams one tiny `model: "auto"` turn, asserts the turn completes with text, and — when the router emits `X-Manifest-*` headers — asserts the `ResolvedRoute` shape (it does not hard-require the headers, since a proxy may strip them; it logs what it saw).

```sh
MANIFEST_LIVE=1 MANIFEST_API_KEY=mnfst_... bun test tests/providers/router.live.test.ts
# optional: MANIFEST_BASE_URL=https://app.manifest.build/v1 to hit the cloud
```

The offline suite (`tests/providers/router.test.ts`) models the same wire with a fake fetch — header merge (auth un-maskable), the route-report seam, and inherited SSE/tool/usage translation.

---

## Read next

- [`04-extending/metering-an-agent.md`](metering-an-agent.md) — the Assay usage wire (what "prices the alias, not the routed model" refers to).
- [`04-extending/extending.md`](extending.md) — the broader extension recipe set (adding a provider lane).
- `specs/2026-07-06-model-router-adapter-design.md` — the design record (the generic seam + Manifest as the current binding).
