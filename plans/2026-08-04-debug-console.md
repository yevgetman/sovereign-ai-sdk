# Debug Console — Implementation Plan

**Spec:** `specs/2026-08-04-debug-console-design.md` (green-lit 2026-08-04; CEO
confirmed both decisions: custom element, separate package).
**SOP attestation** (kernel:autonomous-plan-execution): `{sop_id: "org/sop/3-autonomous-plan-execution", plan_path: "plans/2026-08-04-debug-console.md", approval_ref_kind: "message", approval_ref_id: "CEO '1. custom element 2. separate package' — Claude session 2026-08-04"}`.
**Gate:** the SDK's own gate, plus Appleo's two gates at the dogfood step.

**Status: COMPLETE 2026-08-05.** Shipped as `@yevgetman/sov-debug-console`
0.2.0 + `@yevgetman/sov-sdk` 0.9.2, mounted live at app.appleo.ai.

## Commit A — the package (`8aa2402`)

- [x] A1: `packages/debug-console/` skeleton — package.json (no runtime deps),
      tsconfig, build to ESM + a prebuilt IIFE (14 KB, self-contained).
- [x] A2: `types.ts` — `AgentFeed`, `AgentDebugEvent`, `TurnDetailEvent`,
      `TelemetryEvent`, `DataEvent`, `DebugConsoleAdapter`.
- [x] A3: `element.ts` — `<sov-debug-console>`: open shadow root, injected
      adapter, capability probe (never invokes), 3s poll while open, drag,
      resize, tab state, copy buttons, session dividers.
- [x] A4: `styles.ts` — the shadow stylesheet, `--sdc-*` custom properties so a
      host themes it without a fork.
- [x] A5: `restAdapter.ts` — `createRestAdapter({ baseUrl, headers })`.
- [x] A6: `register.ts` — idempotent `defineDebugConsole(tag?)`.
- [x] A7: Tests (21) — mounts with no adapter; a tab is ABSENT when its adapter
      method is; probe never invokes; escaping; refusal-is-not-a-crash;
      last-good-frame on adapter failure; grouped data rows.

**Deviation:** the ESM entry does NOT register the element (a bare import must
not mutate the global registry); a separate `iife-entry.ts` does, since a
`<script>` tag implies it.

## Commit B — the collector, SDK side (`deee35a`)

- [x] B1: `packages/sdk/src/debug/collector.ts` — per-principal rings, LRU,
      replay-dedupe watermark.
- [x] B1b: `turn-observer.ts` — the tool name/input pairing across
      `tool_use_start`/`tool_use_done` and reasoning-block accumulation, lifted
      out of Appleo's metering follower where they were entangled.
- [x] B2: `routes.ts` — framework-agnostic handlers + `isPermitted(context)`.
      REQUIRED with no default; a check that throws REFUSES.
- [x] B3: Exported at `@yevgetman/sov-sdk/debug`.
- [x] B4: Tests (42) — the dedupe, the pairing, the accumulation, the refusal.

**Deviation:** Appleo's closed unions (`surface`, telemetry `category`) widen to
`string` in the SDK. One host's enumerations cannot be every host's.

## Commit C — dogfood into Appleo (`3f06434`, `2268b0e`)

- [x] C1: Repin the SDK (0.5.3 → 0.9.2; the turnlog surface Appleo uses is
      byte-identical across the bump); vendor the console package.
- [x] C2: Mount `<sov-debug-console>` behind Appleo's existing role gate and 404
      posture.
- [x] C3: Appleo supplies its OWN telemetry + data adapters.
- [x] C4: PARITY CHECK — see below.

**Deviation (deliberate):** `src/agent/debug-log.ts` was NOT deleted. It became
a ~40-line adapter that keeps Appleo's vocabulary and delegates the machinery.
Deleting it would have pushed SDK vocabulary (`principal`, `surface: string`)
into the host and cost Appleo its narrower domain types — backwards from the
spec's own §2 reasoning. The duplicated LOGIC is gone, which was the point.

## Commit D — release

- [x] D1: Both gates green, docs, memory.

## Parity check (C4) — the acceptance test

Driven in a real browser against the REAL published artifact (the IIFE the
deployed bundle resolves to), with an Appleo-shaped feed:

| Item | Result |
|---|---|
| pill | renders, `DEBUG`, upgraded custom element |
| drag | moved exactly 300×150px, clamped on-screen |
| resize | `resize: both` computed on the panel |
| standalone tab | `new tab ↗` present |
| three tabs | Agent / Telemetry / Data |
| tool inputs | `Bash — resume tailor --branch main --jd /tmp/jd.txt` |
| reasoning rows | `∴ reasoning (4.2k)` + opening preview |
| turn summary | finish reason, tools, tokens, `$0.0131` |
| session dividers | both sessions, each with copy |
| copy buttons | 5 |
| telemetry | 500 highlighted red, 1840ms highlighted slow |
| data groups | commits above HTTP writes, two headings |

Live-bundle verification: `app.appleo.ai/assets/index-*.js` contains the element
tag, its `--sdc-*` properties, its footer text, and Appleo's probe endpoint.

**Not verified end-to-end:** the console behind a real logged-in superadmin
session on production. Only Gene's account holds that role and I will not seed a
production account or reset his password to see a UI. The permission gate and
the adapter mapping are covered by 8 unit tests; the remaining unknown is one
click by Gene.

## Self-review

- Commit A is self-contained and testable without Appleo, which is what made the
  extraction real rather than a move.
- Two portability gaps surfaced at C4 and were fixed IN THE SDK, as the plan
  required: `DataEvent.group` (Appleo's Data tab has two sections), and the
  observer's over-broad collector dependency (narrowed to the one method it
  calls, so a host's richer collector passes in without a cast).
- Risk noted at plan time — the Agent tab's richness depends on the gateway
  event vocabulary — is documented in the package README rather than papered
  over: a host on a different harness gets a thinner Agent tab, honestly.
