// Sovereign local-engine transport. The L1 inference engine is a standalone
// OpenAI-compatible MLX server on loopback (default http://127.0.0.1:8000/v1).
//
// `sov` is a KEYLESS first-class provider — the local lane for our own engine.
// It is exactly an OpenAI-compatible Chat-Completions client minus the
// key requirement and the always-on Authorization header, so it extends
// OpenAIProvider and overrides only those three seams (key gate, name/apiMode,
// default base URL). Everything else — buildKwargs / messagesToOpenAI / the
// translateOpenAIStream reasoning→thinking translation — is inherited verbatim,
// which is what transparently gives this lane the reasoning_content → thinking
// behavior every OpenAI-compatible backend now shares.
//
// Design: docs/specs/2026-06-08-sov-provider-design.md (Bucket A).

import { OpenAIProvider } from './openai.js';
import type { ApiMode } from './types.js';

/** Config for the keyless local Sovereign lane. `apiKey` is optional — when
 *  absent, no Authorization header is sent. */
export type SovProviderConfig = {
  apiKey?: string;
  baseURL?: string;
  name?: string;
  fetchImpl?: typeof fetch;
};

export class SovProvider extends OpenAIProvider {
  override readonly apiMode: ApiMode = 'sov';

  constructor(config: SovProviderConfig = {}) {
    super(config);
  }

  /** Keyless: a missing apiKey is fine (loopback engine, no auth). */
  protected override requiresApiKey(): boolean {
    return false;
  }

  protected override defaultName(): string {
    return 'sov';
  }

  protected override defaultBaseUrl(): string {
    return 'http://127.0.0.1:8000/v1';
  }
}
