// src/conduct/decorumAdapter.ts — native adapter SKELETON for the decorum
// Conduct & Persona Engine (spec D30: repo ~/code/decorum, npm
// @yevgetman/decorum). 1b ships the SHAPE only: an inert ConductProvider and
// the wiring contract. The engine's 1c build fills the capabilities by
// importing @yevgetman/decorum here (wrapper side — the open SDK core never
// depends on the engine; D5/D11).
//
// Wiring contract (when the engine lands):
//   - options carry the conduct.yaml path + pack directory; the engine loads,
//     validates (fail-closed at LOAD, never per-turn), and hot-reloads them
//     internally — the provider HANDLE stays stable across reloads.
//   - capabilities map 1:1 onto engine organs: personaSegments ← PackSystem
//     projection; preGate ← InputGate; triage ← IntentTriage; toolPolicy ←
//     tool rules; outputGuard ← OutputGovernor (buffered verifyTurn first —
//     spec sub-phase 1d); auditSink ← the engine's Audit emitter.
//   - binding: pass the provider as RuntimeOptions.conduct at boot
//     (src/server/runtime.ts), which threads it to every surface.

import type { ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';

export type DecorumAdapterOptions = {
  /** Path to conduct.yaml (reserved — consumed when the engine lands). */
  configPath?: string;
  /** Pack directory (reserved — consumed when the engine lands). */
  packDir?: string;
};

/** Build the decorum-engine ConductProvider. 1b: inert (no capabilities) —
 *  binding it changes nothing, by the port's all-optional contract. */
export function createDecorumAdapter(_options: DecorumAdapterOptions = {}): ConductProvider {
  return {};
}
