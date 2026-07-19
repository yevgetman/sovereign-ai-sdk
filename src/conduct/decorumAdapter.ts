// src/conduct/decorumAdapter.ts — the native adapter for the decorum Conduct &
// Persona Engine (spec D30: repo ~/code/decorum, npm @yevgetman/decorum). This
// is the WRAPPER side: it imports the engine and returns a REAL ConductProvider
// bound to a deployment `conduct.yaml` binding. The open SDK core never depends
// on the engine (D5/D11) — only this file (in the root `@yevgetman/sov`
// package) does.
//
// Wiring contract:
//   - options carry the deploy-binding conduct.yaml path (`configPath`) and/or a
//     directory holding it (`packDir`). The engine loads, validates, and
//     hot-reloads the pack/config internally — the provider HANDLE stays stable
//     across reloads (D10).
//   - capabilities map 1:1 onto engine organs: personaSegments ← PackSystem
//     projection; preGate ← InputGate; triage ← IntentTriage; toolPolicy ←
//     tool rules; outputGuard ← OutputGovernor; auditSink ← the engine's Audit
//     emitter.
//   - binding: pass the provider as RuntimeOptions.conduct at boot
//     (src/cli/gatewayCommand.ts → buildRuntime), which threads it to every
//     surface.
//
// FAIL-CLOSED (D4): construction throws at gateway boot on a missing/invalid
// pack. We deliberately do NOT catch — a governance binding that will not load
// must stop the gateway from booting into a no-governance state, never silently
// fall back to the null provider.

import { join } from 'node:path';
import { DECORUM_AUDIT_SCHEMA_VERSION, createDecorumProvider } from '@yevgetman/decorum';
import type {
  AttestationSink,
  DecorumAuditEvent,
  OverlayRejection,
  ScopeOverlay,
} from '@yevgetman/decorum';
import type { ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import type { TraceEvent } from '@yevgetman/sov-sdk/trace/types';

/** Conventional filename of a deploy-binding conduct.yaml inside a `packDir`. */
const DEPLOY_BINDING_FILENAME = 'conduct.yaml';

export type DecorumAdapterOptions = {
  /** Path to a deployment-binding `conduct.yaml` (§6.4). Primary input. */
  configPath?: string;
  /** Directory holding the deploy-binding `conduct.yaml`. Used only when
   *  `configPath` is unset — the binding is resolved as
   *  `<packDir>/conduct.yaml`. An explicit `configPath` always wins. */
  packDir?: string;
  /** The tenant's directive overlay (decorum's third conduct layer). Bound ONCE
   *  here, at boot, so this gateway process serves exactly ONE scope — decorum
   *  forbids sharing a sessionId across the base and a scoped provider, and a
   *  boot-bound scope makes that structurally impossible. Absent ⇒ the base
   *  provider is returned unchanged (byte-identical). */
  overlay?: ScopeOverlay;
  /** Late-bound inlet to the SDK's per-session trace (Runtime.recordExternalTrace).
   *  When provided, decorum's content-free audit events are forwarded as
   *  `{type:'external', source:'decorum'}` trace events, routed by the event's
   *  own `sessionId`. Absent ⇒ no audit sink ⇒ byte-identical (no governance
   *  observability). This is the SOLE decorum→SDK-trace coupling point. */
  emitExternalTrace?: (sessionId: string, event: TraceEvent) => void;
  /** Attestation records sink (evidence spec 2026-07-19 §3.1). Forwarded to
   *  `createDecorumProvider` EXACTLY as `auditSink` is: present ⇒ decorum
   *  hands it the full `DecisionRecord` for every decision (observation —
   *  fails open inside decorum; a throwing sink never breaks a governed
   *  turn); ABSENT ⇒ not passed ⇒ byte-identical (no attestation at all).
   *  The gateway wires this to the AttestationWriter's verbatim
   *  records.jsonl persistence. */
  attestationSink?: AttestationSink;
};

/** The content-free result of binding an overlay at boot: how many directives
 *  decorum accepted, and a per-directive rejection list carrying reason codes
 *  ONLY — never the tenant's text. A host surfaces this so a user whose rule was
 *  refused (e.g. it read as prompt injection) learns it was refused, instead of
 *  the rule silently never applying. Absent `overlay` ⇒ undefined. */
export type OverlayIntake = {
  readonly accepted: number;
  readonly rejected: readonly OverlayRejection[];
};

/**
 * Resolve the effective deploy-binding path from the adapter options.
 *
 * Precedence: an explicit `configPath` wins; otherwise `<packDir>/conduct.yaml`.
 * A `conduct` config block with NEITHER is a misconfiguration — the operator
 * asked for governance, so we throw (fail-closed) rather than degrade to the
 * null provider.
 */
function resolveConfigPath(options: DecorumAdapterOptions): string {
  if (options.configPath !== undefined && options.configPath.length > 0) {
    return options.configPath;
  }
  if (options.packDir !== undefined && options.packDir.length > 0) {
    return join(options.packDir, DEPLOY_BINDING_FILENAME);
  }
  throw new Error(
    'decorum conduct binding requires a path: set `conduct.configPath` (a ' +
      'deploy-binding conduct.yaml) or `conduct.packDir` (a directory holding ' +
      'conduct.yaml) in your gateway config',
  );
}

/**
 * Build the decorum-engine {@link ConductProvider} bound to a deployment
 * conduct.yaml. The returned provider enforces the pack's floors, projects its
 * persona, runs the input gate, and applies its tool policy + output governor.
 *
 * TRIAGE (host model call) is dropped for this first release: `reasoner` is
 * wired as UNDEFINED, so decorum omits the triage capability entirely. Every
 * OTHER capability — the enforced floors, persona projection, input gate, tool
 * policy, and output governor — is mechanical and functions without it. TODO
 * (reasoner seam): thread a real host model call here to re-enable intent
 * triage once the gateway exposes a small-model lane for it.
 *
 * AUDIT: decorum emits typed, content-free audit events to an optional
 * `auditSink`. When the caller supplies `emitExternalTrace` (the late-bound
 * `Runtime.recordExternalTrace` inlet), the adapter builds a sink that forwards
 * decorum's OWN rich events into the SDK's per-session trace as
 * `{type:'external', source:'decorum'}`. Absent that inlet, NO sink is passed —
 * byte-identical to a no-audit boot.
 *
 * FAIL-CLOSED: {@link createDecorumProvider} throws at construction on a
 * missing/invalid pack; that throw propagates to gateway boot (no catch).
 *
 * OVERLAY: when `options.overlay` is present the tenant's directives are folded
 * on via `provider.withOverlay` and the SCOPED provider is returned, together
 * with the content-free {@link OverlayIntake}. decorum owns the vetting — each
 * free-text directive runs the input gate's injection screen at intake and
 * compiles to a DISCRETIONARY (advisory) rule; anything that would loosen a base
 * rule is refused. Binding here (once, at boot) is deliberate: one gateway
 * process then serves exactly one scope, so a sessionId can never straddle the
 * base and a scoped provider. Absent `overlay` ⇒ base provider, `intake`
 * undefined, byte-identical to before.
 */
export function createDecorumAdapter(options: DecorumAdapterOptions = {}): {
  provider: ConductProvider;
  intake?: OverlayIntake;
} {
  const configPath = resolveConfigPath(options);
  const emitExternalTrace = options.emitExternalTrace;
  // Forward ONLY decorum's own rich audit events (schemaVersion present) as
  // external trace events. The provider ALSO re-exposes this sink to catch the
  // SDK's thin seam-verdict events (decorum provider.ts:1410); those lack a
  // schemaVersion and are dropped here so the trail carries exactly one rich
  // record per decision (dedup). Routing is by the event's own `sessionId` via
  // the late-bound recorder.
  const auditSink = emitExternalTrace
    ? (event: DecorumAuditEvent): void => {
        if (event.schemaVersion !== DECORUM_AUDIT_SCHEMA_VERSION) return;
        emitExternalTrace(event.sessionId, {
          type: 'external',
          source: 'decorum',
          iso: event.iso,
          payload: event,
        });
      }
    : undefined;
  const provider = createDecorumProvider({
    configPath,
    ...(auditSink ? { auditSink } : {}),
    // Attestation (§3.1): the records sink rides the SAME conditional-spread
    // discipline as auditSink — absent ⇒ the key is never passed ⇒ decorum
    // composes zero sinks (byte-identical to a provider with no attestation).
    ...(options.attestationSink ? { attestationSink: options.attestationSink } : {}),
  });
  if (options.overlay === undefined) return { provider };
  // Fold the tenant's directives onto the boot-frozen base composition. decorum
  // never mutates the base: it hands back a scope-bound provider (or the base
  // itself when nothing was accepted — a disabled `overlays:` envelope, an
  // all-rejected set, or an empty one), plus the per-directive verdicts.
  const { provider: scoped, accepted, rejected } = provider.withOverlay(options.overlay);
  return { provider: scoped, intake: { accepted, rejected } };
}
