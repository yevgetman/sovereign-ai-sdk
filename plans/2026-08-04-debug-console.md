# Debug Console — Implementation Plan

**Spec:** `specs/2026-08-04-debug-console-design.md` (green-lit 2026-08-04; CEO
confirmed both decisions: custom element, separate package).
**SOP attestation** (kernel:autonomous-plan-execution): `{sop_id: "org/sop/3-autonomous-plan-execution", plan_path: "plans/2026-08-04-debug-console.md", approval_ref_kind: "message", approval_ref_id: "CEO '1. custom element 2. separate package' — Claude session 2026-08-04"}`.
**Gate:** the SDK's own gate, plus Appleo's two gates at the dogfood step.

## Commit A — the package

- [ ] A1: `packages/debug-console/` skeleton — package.json (no runtime deps),
      tsconfig, build to ESM + a prebuilt IIFE.
- [ ] A2: `types.ts` — `AgentFeed`, `AgentDebugEvent`, `TurnDetailEvent`,
      `TelemetryEvent`, `DataEvent`, `DebugConsoleAdapter`.
- [ ] A3: `element.ts` — `<sov-debug-console>`: open shadow root, injected
      adapter, capability probe (never invokes), 3s poll while open, drag,
      resize, tab state, copy buttons, session dividers.
- [ ] A4: `styles.ts` — the shadow stylesheet, `--sdc-*` custom properties so a
      host themes it without a fork.
- [ ] A5: `restAdapter.ts` — `createRestAdapter({ baseUrl, headers })`.
- [ ] A6: `register.ts` — idempotent `defineDebugConsole(tag?)`.
- [ ] A7: Tests — mounts with no adapter; a tab is ABSENT when its adapter
      method is; probe never invokes; drag clamps; poll only while open.

## Commit B — the collector (SDK side)

- [ ] B1: `packages/sdk/src/debug/collector.ts` — port Appleo's `debug-log.ts`:
      per-principal rings, LRU, replay-dedupe watermark, tool name/input pairing
      across `tool_use_start`/`tool_use_done`, reasoning-block accumulation.
- [ ] B2: `packages/sdk/src/debug/routes.ts` — framework-agnostic handlers +
      `isPermitted(context)`. The SDK ships NO authorization model.
- [ ] B3: Exported at `@yevgetman/sov-sdk/debug`.
- [ ] B4: Tests — the dedupe, the pairing, the accumulation, the refusal.

## Commit C — dogfood into Appleo

- [ ] C1: Repin the SDK; add the console package.
- [ ] C2: Delete `web/src/debug/*` and `src/agent/debug-log.ts`; mount
      `<sov-debug-console>` behind Appleo's existing role gate and 404 posture.
- [ ] C3: Appleo supplies its OWN telemetry + data adapters (HTTP requests, git
      commits) — its vocabulary, per spec §2.
- [ ] C4: PARITY CHECK in a browser against production: pill placement, drag,
      resize, `/debug` tab, three tabs, tool inputs, reasoning rows, session
      dividers, copy. Any regression is a portability gap → fix in the SDK.

## Commit D — release

- [ ] D1: SDK release, Appleo repin, both gates green, docs, memory.

## Self-review

- Commit A is self-contained and testable without Appleo, which is what makes
  the extraction real rather than a move.
- C4 is the acceptance test for the whole build: behaviour identical, or the
  extraction is incomplete.
- Risk: the Agent tab's richness depends on the gateway event vocabulary. It is
  the SDK's own stream, so this is safe — but the docs must say a different
  harness yields a thinner tab rather than implying universality.
