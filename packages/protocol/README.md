# @yevgetman/sov-protocol

The typed wire contract for the Sovereign AI gateway (Contract #2) — the SSE
`ServerEvent` union, the six endpoint request/response shapes, the
`PROTOCOL_PATHS` route templates, and a thin, dependency-free `fetch`-based
client. One typed source of truth for anything that talks to a running
`sov gateway` (the Go TUI, `sov drive`, external apps), instead of each
consumer re-deriving the wire shapes by hand.

Runs on **Node ≥ 20** and **Bun ≥ 1.2**. **Zero runtime dependencies.**

## Install

```sh
npm install @yevgetman/sov-protocol   # Node
bun add @yevgetman/sov-protocol       # Bun
```

## Quickstart

Against a running gateway (`sov gateway`, default port 8766, bearer-token
auth): create a session, submit a turn, stream the typed events.

```ts
import { createSession, postTurn, streamEvents } from '@yevgetman/sov-protocol';

const baseUrl = 'http://127.0.0.1:8766'; // where your `sov gateway` listens
const token = process.env.SOV_GATEWAY_TOKEN ?? '';

// 1. Mint a session. 201 → { sessionId, createdAt }.
const { sessionId } = await createSession(baseUrl, token);

// 2. Submit a user turn. Fire-and-forget on the server (202 → { accepted }):
//    the output arrives on the event stream, not in this response.
await postTurn(baseUrl, token, sessionId, { text: 'Hello, gateway' });

// 3. Stream typed ServerEvents over SSE.
for await (const event of streamEvents(baseUrl, token, sessionId)) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
  if (event.type === 'turn_complete' || event.type === 'turn_error') break;
}
```

The full client surface is six endpoint functions plus the stream:

| Function | Endpoint |
|---|---|
| `createSession(baseUrl, token, body?)` | `POST /sessions` |
| `postTurn(baseUrl, token, sessionId, body)` | `POST /sessions/:id/turns` |
| `postApproval(baseUrl, token, sessionId, requestId, body)` | `POST /sessions/:id/approvals/:requestId` |
| `cancel(baseUrl, token, sessionId)` | `POST /sessions/:id/cancel` |
| `health(baseUrl)` | `GET /health` (no auth) |
| `streamEvents(baseUrl, token, sessionId, opts?)` | `GET /sessions/:id/events` (SSE) |

`streamEvents` accepts `{ lastEventId, signal }`: `lastEventId` is sent as the
standard `Last-Event-ID` reconnect header (the gateway replays only events
with a greater `seq`), and `signal` aborts a still-active read from outside.
Breaking out of the loop early (the "stop on a terminal event" pattern above)
is cleanly torn down on its own — the stream is cancelled and the underlying
fetch/SSE connection closes — so you do not need to wire an `AbortSignal` purely
for teardown.

The client trusts the typed contract: runtime validation stays server-side
(the gateway keeps its zod schemas), so this package carries no zod and no
other runtime dependency. A non-2xx response throws an `Error` surfacing the
gateway's `{ error }` envelope.

## Public surface & versioning

The package entry (`@yevgetman/sov-protocol`) is the semver'd public API —
`PROTOCOL_PATHS`, the six client functions, and the exported request/response
and event types. There are no deep subpaths. Full policy:
[`STABILITY.md`](https://github.com/yevgetman/sovereign-ai-sdk/blob/master/STABILITY.md) at the repository root.

## License

MIT.
