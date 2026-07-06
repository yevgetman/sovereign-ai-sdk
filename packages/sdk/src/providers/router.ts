// Generic model-router transport. Speaks to any OpenAI-compatible model-routing
// proxy: the caller stops picking a model (it asks for `"auto"`) and the router
// chooses the upstream by cost/capability/locality/subscription/fallbacks. The
// current binding is a self-hosted Manifest instance (default
// http://localhost:2099/v1) — but nothing here imports Manifest; the coupling is
// only the OpenAI-compatible wire plus the pinned X-Manifest-* header names, so
// the router stays swappable (a future router = a baseURL override or a new
// registry entry on this same class).
//
// Like `sov`, this is an OpenAI Chat-Completions client with two extra seams:
//  - a static `headers` map carrying routing hints (custom tier headers,
//    `x-session-key` for sticky sessions / prompt caching); and
//  - an opt-in `onRouteResolved` callback that surfaces what the router actually
//    did, parsed from the `X-Manifest-*` response headers via the base
//    `onResponse` hook. Best-effort: a throwing callback is swallowed so it can
//    never break the turn (the traceRecorder posture).
// Everything else — buildKwargs / messagesToOpenAI / translateOpenAIStream — is
// inherited verbatim, so tool passthrough and usage/SSE translation are shared.
//
// Design: specs/2026-07-06-model-router-adapter-design.md (R1, R2).

import { OpenAIProvider } from './openai.js';
import type { ApiMode } from './types.js';

/** The route a router reports for a request. Every field is optional: the
 *  router may report any subset (absent header ⇒ absent field). */
export type ResolvedRoute = { model?: string; provider?: string; tier?: string; reason?: string };

/** Config for the generic model-router lane. Extends the OpenAI transport config
 *  with static routing-hint headers and an opt-in route-report callback. */
export type RouterProviderConfig = {
  apiKey?: string;
  baseURL?: string;
  name?: string;
  fetchImpl?: typeof fetch;
  /** Static routing-hint headers (e.g. a Manifest custom-tier header, x-session-key). */
  headers?: Record<string, string>;
  /** Fires when the router reports the resolved route (X-Manifest-* response headers). Best-effort: a throwing callback is swallowed. */
  onRouteResolved?: (route: ResolvedRoute) => void;
};

export class RouterProvider extends OpenAIProvider {
  override readonly apiMode: ApiMode = 'router';

  constructor(private readonly routerConfig: RouterProviderConfig = {}) {
    super(routerConfig);
  }

  protected override defaultName(): string {
    return 'router';
  }

  protected override defaultBaseUrl(): string {
    return 'http://localhost:2099/v1';
  }

  /** Routing-hint headers merged FIRST, then the base content-type/authorization
   *  applied on top — so a hint header can never mask the real auth or the JSON
   *  content-type. */
  protected override requestHeaders(): Record<string, string> {
    const custom = this.routerConfig.headers ?? {};
    return { ...custom, ...super.requestHeaders() };
  }

  /** Parse the router's route-report response headers and, when any is present,
   *  hand the resolved route to `onRouteResolved` inside a try/catch. */
  protected override onResponse(response: Response): void {
    const callback = this.routerConfig.onRouteResolved;
    if (!callback) return;

    // Headers.get is case-insensitive; a missing header returns null.
    const model = response.headers.get('x-manifest-model');
    const provider = response.headers.get('x-manifest-provider');
    const tier = response.headers.get('x-manifest-tier');
    const reason = response.headers.get('x-manifest-reason');
    if (model === null && provider === null && tier === null && reason === null) return;

    // exactOptionalPropertyTypes: conditionally spread each field so an absent
    // header yields an absent key rather than `undefined`.
    const route: ResolvedRoute = {
      ...(model !== null ? { model } : {}),
      ...(provider !== null ? { provider } : {}),
      ...(tier !== null ? { tier } : {}),
      ...(reason !== null ? { reason } : {}),
    };
    try {
      callback(route);
    } catch {
      // Best-effort route reporting: a throwing callback must never break the turn.
    }
  }
}
