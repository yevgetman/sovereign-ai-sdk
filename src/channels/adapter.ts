// Channel adapter contract — the behavioral interface every channel
// (Telegram / Slack / webhook, Phase F-T4/5/6) implements, plus a tiny
// in-process registry. The data types (InboundMessage, DeliveryResult) live in
// ./types.ts; this module adds the verify → run → deliver lifecycle.
//
// The contract is deliberately minimal: the gateway (Phase F-T7) calls
// `verify` on an inbound HTTP request to authenticate it and parse it into an
// InboundMessage, runs the harness turn under the safe channel posture (see
// ./permission.ts), then calls `deliver` to send the reply back out over the
// channel's own transport. Adapters refine `VerifyInput`/the transport `T` to
// their own needs.

import type { DeliveryResult, InboundMessage } from './types.js';

/** Raw inbound request handed to an adapter's verify(). Adapters narrow this
 *  to their own request shape; the gateway populates body + headers. */
export type VerifyInput = {
  /** Raw request body, before any adapter-specific parsing. */
  rawBody: unknown;
  /** Lowercased request headers (signature, content-type, etc.). */
  headers: Record<string, string>;
};

/** Outcome of verifying + parsing an inbound request.
 *  - ok:false  → reject; `status` is the HTTP status the gateway should return.
 *  - ok:true   → proceed; `message` is the parsed InboundMessage to run.
 *  `challengeResponse` carries a platform handshake echo (e.g. Slack URL
 *  verification) the gateway returns verbatim instead of running a turn. */
export type VerifyResult = {
  ok: boolean;
  message?: InboundMessage;
  challengeResponse?: unknown;
  status?: number;
};

/** The capability contract for a channel. `T` is the adapter's outbound
 *  transport handle (a bot client, a webhook URL, etc.). */
export interface ChannelAdapter<T = unknown> {
  /** Stable channel id, e.g. 'telegram' / 'slack'. Used as the registry key. */
  id: string;
  /** Authenticate + parse an inbound request. Must be constant-time on any
   *  signature comparison (the adapters own that; the contract just requires
   *  a verdict). */
  verify(input: VerifyInput): Promise<VerifyResult>;
  /** Send a reply back over the channel transport. */
  deliver(reply: string, msg: InboundMessage, transport: T): Promise<DeliveryResult>;
}

// ── In-process registry ──────────────────────────────────────────────────────
// Channels register at boot; the gateway resolves by id. Kept tiny on purpose.

const registry = new Map<string, ChannelAdapter>();

/** Register a channel adapter. Throws on a duplicate id so a wiring mistake
 *  fails loudly rather than silently shadowing an existing channel. */
export function registerChannelAdapter(adapter: ChannelAdapter): void {
  if (registry.has(adapter.id)) {
    throw new Error(`channel adapter "${adapter.id}" is already registered`);
  }
  registry.set(adapter.id, adapter);
}

/** Resolve a registered adapter by id, or undefined if none is registered. */
export function getChannelAdapter(id: string): ChannelAdapter | undefined {
  return registry.get(id);
}

/** Drop all registered adapters. Primarily for test isolation. */
export function clearChannelAdapters(): void {
  registry.clear();
}
