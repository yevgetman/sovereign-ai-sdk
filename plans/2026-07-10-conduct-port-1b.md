# Conduct Port (1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the vendor-neutral `ConductProvider` port and its five choke-point seams (persona segments, preGate, triage, tool policy, output-delivery gate) in the SDK, with a null default that is byte-identical to today — zero behavior change for every live deployment.

**Architecture:** A single optional port type (`ConductProvider`, all capabilities optional) lives in the open core beside `recallPort`/`observePort`. `query()` hosts the input-side seams (preGate after the UserPromptSubmit rewrite, triage before the first provider call). `createAgent()` hosts the composition seams (persona segments into the system prompt, tool policy wrapped around `canUseTool`, the output gate in its drive loop — the one choke point every surface passes through). The wrapper binds a provider per session/runtime and threads it into each of its `createAgent` call sites. The engine (decorum, spec D30) arrives later behind this port; 1b ships only the port, seams, a skeleton adapter, and proof of no-bypass.

**Tech Stack:** TypeScript on Bun ≥ 1.2, bun:test, biome, dependency-cruiser boundary lint. No new dependencies.

## Global Constraints

- **Null-provider invariant (load-bearing):** absent `conduct` ⇒ byte-identical behavior on every surface. The full existing suite (`bun test`, ~4300+ pass) is the enforcement; it must stay green after every task.
- **Open-core boundary:** everything under `packages/sdk/src/` may not import from root `src/` (`bun run boundary`, part of `bun run lint`). The port type + seams are open; the decorum adapter skeleton + per-surface binding are wrapper (root `src/`).
- **Learning-loop soak is ACTIVE (repo CLAUDE.md):** do not disable or alter `learning.recall` / observer behavior; recall injection order in `query()` is untouched (conduct preGate runs AFTER memory+recall injection and AFTER the UserPromptSubmit rewrite, by design — D23).
- **exactOptionalPropertyTypes discipline:** thread optional fields via conditional spreads (`...(x !== undefined ? { x } : {})`), matching every existing call site.
- Imports use `.js` suffixes; open-core test imports use the `@yevgetman/sov-sdk/...` specifiers (see `tests/agent/createAgent.test.ts`).
- Commits: conventional, scoped — `feat(conduct): ...`, `test(conduct): ...` — matching `git log` style.
- Gate per task: `bun run typecheck && bun run lint && bun test <touched files>`; full `bun test` at Tasks 5, 7, 10, 12.
- Content-free audit: `ConductAuditEvent` carries verdicts/latency only — never message text.

---

### Task 1: ConductProvider port types + audit-sink wrapper (open core)

**Files:**
- Create: `packages/sdk/src/core/conductPort.ts`
- Modify: `packages/sdk/src/sdk.ts` (barrel exports, near line 277–280 where `RecallResult`/`ObserveInput` are exported)
- Test: `tests/core/conductPort.test.ts`

**Interfaces:**
- Consumes: `SystemSegment`, `AssistantMessage` from `../core/types.js`.
- Produces (used by every later task): `ConductProvider`, `ConductContext`, `ConductSurface`, `PreGateVerdict`, `TriageVerdict`, `ConductToolVerdict`, `OutputFinalVerdict`, `ConductOutputGuard`, `ConductAuditEvent`, `ConductStage`, `wrapConductAuditSink(sink?) => (event) => void`, `DEFAULT_CONDUCT_REFUSAL`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/conductPort.test.ts — port-type contract + audit wrapper.
//
// The ConductProvider port is ALL-OPTIONAL (spec §10 item 9 resolution: one
// interface, optional capability slices): an empty object is a valid provider
// and must behave as the null provider at every seam. wrapConductAuditSink
// mirrors makeTraceRecorder (query.ts): absent sink → no-op; a throwing sink
// is swallowed (a misbehaving audit sink must never break a turn).

import { describe, expect, test } from 'bun:test';
import {
  type ConductAuditEvent,
  type ConductContext,
  type ConductProvider,
  DEFAULT_CONDUCT_REFUSAL,
  wrapConductAuditSink,
} from '@yevgetman/sov-sdk/core/conductPort';

describe('conductPort', () => {
  test('an empty object is a valid ConductProvider (all capabilities optional)', () => {
    const provider: ConductProvider = {};
    expect(provider.personaSegments).toBeUndefined();
    expect(provider.preGate).toBeUndefined();
    expect(provider.triage).toBeUndefined();
    expect(provider.toolPolicy).toBeUndefined();
    expect(provider.outputGuard).toBeUndefined();
    expect(provider.allowPerTurnInstructions).toBeUndefined();
    expect(provider.auditSink).toBeUndefined();
  });

  test('wrapConductAuditSink: absent sink is a no-op function', () => {
    const emit = wrapConductAuditSink(undefined);
    expect(() =>
      emit({
        stage: 'pregate',
        sessionId: 's1',
        surface: 'user',
        verdict: 'allow',
        iso: new Date().toISOString(),
      }),
    ).not.toThrow();
  });

  test('wrapConductAuditSink: a throwing sink is swallowed, events still delivered before the throw', () => {
    const seen: ConductAuditEvent[] = [];
    const emit = wrapConductAuditSink((event) => {
      seen.push(event);
      throw new Error('sink exploded');
    });
    const ctx: ConductContext = {
      sessionId: 's1',
      surface: 'user',
      model: 'm',
      providerName: 'p',
    };
    expect(() =>
      emit({
        stage: 'output',
        sessionId: ctx.sessionId,
        surface: ctx.surface,
        verdict: 'pass',
        latencyMs: 3,
        iso: new Date().toISOString(),
      }),
    ).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stage).toBe('output');
  });

  test('DEFAULT_CONDUCT_REFUSAL is a non-empty string', () => {
    expect(DEFAULT_CONDUCT_REFUSAL.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/conductPort.test.ts`
Expected: FAIL — `Cannot find module '@yevgetman/sov-sdk/core/conductPort'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/sdk/src/core/conductPort.ts — the vendor-neutral Conduct Port.
//
// Agent-plane governance choke points (Conduct & Persona Engine spec §6.1,
// ~/code/me/specs/2026-07-08-sov-conduct-module-design.md). The SDK ships the
// PORT + seams only; any engine (our decorum, or a third party) implements
// this interface. ALL capabilities are optional — one interface, optional
// capability slices (resolves spec §10 item 9) — and an ABSENT provider (or an
// empty object) is the null provider: byte-identical to pre-port behavior at
// every seam. That invariant is enforced by the existing full test suite plus
// tests/core/conductPort.test.ts and tests/agent/createAgent.conduct.test.ts.
//
// Seam placement (who calls what):
//   - query():      preGate (AFTER the UserPromptSubmit rewrite — it sees the
//                   FINAL text, including injected memory/recall prefix; D23),
//                   triage (once, before the first provider call; fail-open).
//   - createAgent(): personaSegments (system-prompt composition), toolPolicy
//                   (outer deny-first wrapper around canUseTool), outputGuard
//                   (the drive-loop delivery gate every surface passes through),
//                   audit wiring.
//   - wrapper:      per-session/runtime binding; allowPerTurnInstructions
//                   gating at the gateway wire boundary.
//
// Surface discipline (D23): persona/preGate/triage run only on 'user' turns;
// toolPolicy and outputGuard run on EVERY turn ('internal' sub-turns keep
// their floors). NOTE: sub-agents that run as SUBPROCESSES (tasks/manager
// spawning `sov drive`) are separate processes — an in-process provider object
// does not cross that boundary; those runs bind their own provider via their
// own runtime. This is a named trust boundary, not a gap in this port.
//
// Failure posture at the SDK seams: a THROWN capability fails OPEN (the turn
// proceeds; the audit event records verdict 'error'). Fail-closed postures
// (D4: regulated packs) are the ENGINE's job, implemented INSIDE its
// capability functions — the SDK never decides policy.
//
// Hot-reload: the provider HANDLE is stable per session; the engine hot-reloads
// packs/config internally behind it. No liveApply hook is needed at this layer.

import type { AssistantMessage, SystemSegment } from './types.js';

/** Which kind of turn this is. 'user' = a human-facing turn (gateway, TUI,
 *  channels, cron reply, machine contract). 'internal' = an in-process
 *  sub-turn driven by the harness itself. */
export type ConductSurface = 'user' | 'internal';

/** Per-turn identity the seams hand to every capability. Content-free. */
export type ConductContext = {
  readonly sessionId: string;
  readonly surface: ConductSurface;
  readonly model: string;
  readonly providerName: string;
  readonly cwd?: string;
};

/** preGate verdict — deny/rewrite semantics mirroring the UserPromptSubmit
 *  hook (query.ts): 'allow' proceeds; 'rewrite' replaces the latest user
 *  message's text block WHOLESALE (the gate saw the full composed text,
 *  including any injected memory/recall prefix — preserving that prefix is
 *  the rewriter's responsibility); 'deny' with refusalText synthesizes an
 *  assistant refusal reply and completes the turn; 'deny' without refusalText
 *  terminates with reason 'error' (the UserPromptSubmit-deny precedent). */
export type PreGateVerdict =
  | { action: 'allow' }
  | { action: 'rewrite'; text: string }
  | { action: 'deny'; refusalText?: string };

/** Intent-triage verdict (spec D3): posture-shaping, small-model, fail-open.
 *  posture 'refuse' short-circuits pre-model into a synthesized refusal reply
 *  (refusalText, else DEFAULT_CONDUCT_REFUSAL). Other postures are advisory
 *  in 1b — recorded to audit; the engine consumes them when it arrives. */
export type TriageVerdict = {
  genuine: boolean;
  posture?: 'open' | 'guarded' | 'refuse';
  refusalText?: string;
};

/** Tool-policy verdict. 'deny' wins outright (deny-first composition); a
 *  non-deny defers to the inner canUseTool cascade unchanged. */
export type ConductToolVerdict = { behavior: 'allow' } | { behavior: 'deny'; reason?: string };

/** Output-gate verdict for one assistant message. 'replace' / 'block'
 *  substitute the message's TEXT blocks only — tool_use blocks are preserved
 *  verbatim so tool_use/tool_result adjacency in the persisted transcript is
 *  never broken. 'block' without a template uses DEFAULT_CONDUCT_REFUSAL. */
export type OutputFinalVerdict =
  | { action: 'pass' }
  | { action: 'replace'; text: string }
  | { action: 'block'; template?: string };

/** The output-delivery gate. onDelta transforms/holds streaming text deltas
 *  (return '' to hold — the ENGINE owns any internal lookahead buffer; the SDK
 *  only routes deltas through). onFinal verdicts each assistant message before
 *  it reaches consumers/persistence. Both optional. */
export type ConductOutputGuard = {
  onDelta?(text: string, ctx: ConductContext): string;
  onFinal?(
    message: AssistantMessage,
    ctx: ConductContext,
  ): Promise<OutputFinalVerdict> | OutputFinalVerdict;
};

export type ConductStage = 'persona' | 'pregate' | 'triage' | 'tool' | 'output';

/** Typed, CONTENT-FREE audit event (spec §6.2 Audit). Never carries message
 *  text — verdict labels, ids, and latency only. */
export type ConductAuditEvent = {
  readonly stage: ConductStage;
  readonly sessionId: string;
  readonly surface: ConductSurface;
  readonly verdict: string;
  readonly latencyMs?: number;
  readonly iso: string;
};

/** The vendor-neutral Conduct Port. All capabilities optional; absent = null
 *  provider = today's behavior, byte-identical. */
export interface ConductProvider {
  /** Ordered persona segments composed into the system prompt (inserted after
   *  the cacheable prefix — see insertPersonaSegments). 'user' surface only. */
  personaSegments?(ctx: ConductContext): Promise<SystemSegment[]> | SystemSegment[];
  /** Input gate over the FINAL post-rewrite user text. 'user' surface only. */
  preGate?(finalUserText: string, ctx: ConductContext): Promise<PreGateVerdict> | PreGateVerdict;
  /** Pre-generation intent triage. 'user' surface only; fail-open. */
  triage?(finalUserText: string, ctx: ConductContext): Promise<TriageVerdict> | TriageVerdict;
  /** Deny-first tool gate composed OUTSIDE the canUseTool cascade. Every surface. */
  toolPolicy?(
    toolName: string,
    input: unknown,
    ctx: ConductContext,
  ): Promise<ConductToolVerdict> | ConductToolVerdict;
  /** The output-delivery gate. Every surface (floors run on internal turns too). */
  outputGuard?: ConductOutputGuard;
  /** Gateway wire-boundary gate for PostTurnRequest.instructions (D23):
   *  return false to drop the per-turn instruction field for this session. */
  allowPerTurnInstructions?(ctx: ConductContext): boolean;
  /** Sink for typed content-free audit events. Wrapped no-throw by the SDK. */
  auditSink?(event: ConductAuditEvent): void;
}

/** Default refusal text when a deny/refuse verdict supplies none. */
export const DEFAULT_CONDUCT_REFUSAL = "I can't help with that request.";

/** Wrap an optional audit sink with a no-throw shim (the makeTraceRecorder
 *  pattern — query.ts): absent → no-op; a throwing sink never breaks a turn. */
export function wrapConductAuditSink(
  sink: ((event: ConductAuditEvent) => void) | undefined,
): (event: ConductAuditEvent) => void {
  if (!sink) return () => {};
  return (event) => {
    try {
      sink(event);
    } catch {
      // Audit is an observer; never propagate.
    }
  };
}
```

- [ ] **Step 4: Add the barrel exports**

In `packages/sdk/src/sdk.ts`, immediately after the `ObservationStatus, ObserveInput` export line (~line 280), add:

```ts
export type {
  ConductAuditEvent,
  ConductContext,
  ConductOutputGuard,
  ConductProvider,
  ConductStage,
  ConductSurface,
  ConductToolVerdict,
  OutputFinalVerdict,
  PreGateVerdict,
  TriageVerdict,
} from './core/conductPort.js';
export { DEFAULT_CONDUCT_REFUSAL, wrapConductAuditSink } from './core/conductPort.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/core/conductPort.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Typecheck + lint (boundary included), then commit**

Run: `bun run typecheck && bun run lint`
Expected: clean; boundary reports 0 open→proprietary.

```bash
git add packages/sdk/src/core/conductPort.ts packages/sdk/src/sdk.ts tests/core/conductPort.test.ts
git commit -m "feat(conduct): vendor-neutral ConductProvider port types + audit wrapper (1b task 1)"
```

---

### Task 2: Persona-segment composition helper

**Files:**
- Create: `packages/sdk/src/core/conductSegments.ts`
- Test: `tests/core/conductSegments.test.ts`

**Interfaces:**
- Consumes: `SystemSegment` from `./types.js`.
- Produces: `insertPersonaSegments(base: SystemSegment[], persona: SystemSegment[]): SystemSegment[]` — used by Task 5 in `createAgent`.

Placement rule (from the 1a projection design + prompt-cache economics): persona segments insert **immediately after the last cacheable base segment** — keeping the stable, cacheable prefix contiguous (base + persona cache together) and ahead of the dynamic tail (system/user context, per-turn instructions). When no base segment is cacheable, persona goes first (identity-first).

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/conductSegments.test.ts
import { describe, expect, test } from 'bun:test';
import { insertPersonaSegments } from '@yevgetman/sov-sdk/core/conductSegments';
import type { SystemSegment } from '@yevgetman/sov-sdk/core/types';

const seg = (text: string, cacheable: boolean): SystemSegment => ({ text, cacheable });

describe('insertPersonaSegments', () => {
  test('inserts after the last cacheable segment, before the dynamic tail', () => {
    const base = [seg('base', true), seg('bundle', true), seg('sysctx', false), seg('userctx', false)];
    const persona = [seg('persona-identity', true), seg('persona-voice', true)];
    const out = insertPersonaSegments(base, persona);
    expect(out.map((s) => s.text)).toEqual([
      'base',
      'bundle',
      'persona-identity',
      'persona-voice',
      'sysctx',
      'userctx',
    ]);
  });

  test('prepends when no base segment is cacheable (identity-first)', () => {
    const base = [seg('dynamic-only', false)];
    const persona = [seg('persona', true)];
    expect(insertPersonaSegments(base, persona).map((s) => s.text)).toEqual([
      'persona',
      'dynamic-only',
    ]);
  });

  test('empty persona returns the SAME array reference (no-op fast path)', () => {
    const base = [seg('a', true)];
    expect(insertPersonaSegments(base, [])).toBe(base);
  });

  test('never mutates the inputs', () => {
    const base = [seg('a', true), seg('b', false)];
    const persona = [seg('p', true)];
    const baseCopy = structuredClone(base);
    const personaCopy = structuredClone(persona);
    insertPersonaSegments(base, persona);
    expect(base).toEqual(baseCopy);
    expect(persona).toEqual(personaCopy);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/conductSegments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/sdk/src/core/conductSegments.ts — persona-segment placement.
//
// Persona segments are cacheable-stable engine output. Inserting them right
// after the cacheable base prefix keeps the provider prompt cache intact
// (stable content stays contiguous) and keeps persona AHEAD of the dynamic
// tail (system/user context, per-turn instruction tails). With no cacheable
// base at all (e.g. a bare-string system prompt), persona leads: identity-first.

import type { SystemSegment } from './types.js';

export function insertPersonaSegments(
  base: SystemSegment[],
  persona: SystemSegment[],
): SystemSegment[] {
  if (persona.length === 0) return base;
  let lastCacheable = -1;
  for (let i = 0; i < base.length; i++) {
    const segment = base[i];
    if (segment !== undefined && segment.cacheable) lastCacheable = i;
  }
  return [...base.slice(0, lastCacheable + 1), ...persona, ...base.slice(lastCacheable + 1)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/conductSegments.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/core/conductSegments.ts tests/core/conductSegments.test.ts
git commit -m "feat(conduct): insertPersonaSegments — cache-preserving persona placement (1b task 2)"
```

---

### Task 3: preGate seam in query()

**Files:**
- Modify: `packages/sdk/src/core/types.ts` (QueryParams — add `conduct?` + `conductCtx?`)
- Modify: `packages/sdk/src/core/query.ts` (insert the preGate block after the UserPromptSubmit block, currently ending line 154)
- Test: `tests/core/queryConduct.test.ts`

**Interfaces:**
- Consumes: `ConductProvider`, `ConductContext`, `PreGateVerdict`, `DEFAULT_CONDUCT_REFUSAL`, `wrapConductAuditSink` (Task 1); existing `rewriteLatestUserText`, `latestUserText`, `fireStopHook` helpers in query.ts.
- Produces: `QueryParams.conduct?: ConductProvider` and `QueryParams.conductCtx?: ConductContext` (threaded by Task 5); the refusal-reply mechanics (`synthesizeConductRefusal`) reused by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `tests/core/queryConduct.test.ts`. Build on the scripted-provider pattern from `tests/core/query.test.ts` (read its provider stub first; reuse its shape). The test file starts with this harness and the preGate cases:

```ts
// tests/core/queryConduct.test.ts — conduct seams inside query(): preGate
// (post-rewrite placement, deny/rewrite/refusal semantics) and triage
// (fail-open, refuse short-circuit). Task 4 appends the triage cases.

import { describe, expect, test } from 'bun:test';
import type {
  ConductAuditEvent,
  ConductContext,
  ConductProvider,
} from '@yevgetman/sov-sdk/core/conductPort';
import { DEFAULT_CONDUCT_REFUSAL } from '@yevgetman/sov-sdk/core/conductPort';
import { query } from '@yevgetman/sov-sdk/core/query';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';

/** One-turn scripted provider: replays a single assistant text reply. */
function scriptedProvider(replyText: string, seen: { requests: Message[][] }): LLMProvider {
  return {
    name: 'scripted',
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    async *stream(req: any): AsyncGenerator<StreamEvent> {
      seen.requests.push(req.messages as Message[]);
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: replyText }],
      };
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: replyText };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
    },
  } as unknown as LLMProvider;
}

const ctx: ConductContext = {
  sessionId: 'conduct-test',
  surface: 'user',
  model: 'test-model',
  providerName: 'scripted',
};

async function drain(
  gen: AsyncGenerator<StreamEvent | Message, Terminal>,
): Promise<{ events: (StreamEvent | Message)[]; terminal: Terminal }> {
  const events: (StreamEvent | Message)[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, terminal: step.value };
    events.push(step.value);
  }
}

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('query() preGate seam', () => {
  test('absent conduct: behavior unchanged (baseline)', async () => {
    const seen = { requests: [] as Message[][] };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(seen.requests).toHaveLength(1);
  });

  test('preGate allow: model sees the original text; audit event fires', async () => {
    const seen = { requests: [] as Message[][] };
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'allow' }),
      auditSink: (e) => audits.push(e),
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(terminal.reason).toBe('completed');
    const pregate = audits.filter((e) => e.stage === 'pregate');
    expect(pregate).toHaveLength(1);
    expect(pregate[0]?.verdict).toBe('allow');
  });

  test('preGate rewrite: the model sees the rewritten text', async () => {
    const seen = { requests: [] as Message[][] };
    const conduct: ConductProvider = {
      preGate: (text) => ({ action: 'rewrite', text: `${text} [gated]` }),
    };
    await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    const sent = seen.requests[0]?.[0]?.content[0];
    expect(sent?.type === 'text' && sent.text).toBe('hello [gated]');
  });

  test('preGate deny WITH refusalText: no model call; synthesized assistant refusal; completed', async () => {
    const seen = { requests: [] as Message[][] };
    const conduct: ConductProvider = {
      preGate: () => ({ action: 'deny', refusalText: 'No can do.' }),
    };
    const { events, terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(seen.requests).toHaveLength(0); // pre-model short-circuit
    expect(terminal.reason).toBe('completed');
    const finals = events.filter(
      (e): e is Extract<StreamEvent, { type: 'assistant_message' }> =>
        'type' in e && e.type === 'assistant_message',
    );
    expect(finals).toHaveLength(1);
    const block = finals[0]?.message.content[0];
    expect(block?.type === 'text' && block.text).toBe('No can do.');
  });

  test('preGate deny WITHOUT refusalText: terminal error (UserPromptSubmit-deny precedent)', async () => {
    const conduct: ConductProvider = { preGate: () => ({ action: 'deny' }) };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', { requests: [] }),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(terminal.reason).toBe('error');
    expect(terminal.error?.message).toContain('conduct preGate');
  });

  test('preGate throw fails OPEN: turn proceeds; audit verdict = error', async () => {
    const seen = { requests: [] as Message[][] };
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      preGate: () => {
        throw new Error('gate exploded');
      },
      auditSink: (e) => audits.push(e),
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(seen.requests).toHaveLength(1);
    expect(audits.find((e) => e.stage === 'pregate')?.verdict).toBe('error');
  });

  test("internal surface: preGate does NOT run (persona/triage/preGate are 'user'-only)", async () => {
    const seen = { requests: [] as Message[][] };
    let called = false;
    const conduct: ConductProvider = {
      preGate: () => {
        called = true;
        return { action: 'deny' };
      },
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: { ...ctx, surface: 'internal' },
      }),
    );
    expect(called).toBe(false);
    expect(terminal.reason).toBe('completed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/queryConduct.test.ts`
Expected: FAIL — `conduct` is not a known QueryParams property (typecheck) / verdicts unhonored at runtime.

- [ ] **Step 3: Add the QueryParams fields**

In `packages/sdk/src/core/types.ts`, add to the `QueryParams` type after the `traceRecorder` field (line ~162):

```ts
  /** Conduct Port (1b) — optional agent-behavior governance provider. Absent
   *  → null provider: byte-identical behavior. query() runs preGate (after
   *  the UserPromptSubmit rewrite; 'user' surface only) and triage (pre-model,
   *  fail-open); the composition seams live in createAgent. */
  conduct?: import('./conductPort.js').ConductProvider;
  /** Per-turn conduct context. Required for the seams to run — createAgent
   *  builds it; a bare query() caller may omit both. */
  conductCtx?: import('./conductPort.js').ConductContext;
```

- [ ] **Step 4: Implement the preGate block in query.ts**

In `packages/sdk/src/core/query.ts`:

(a) Add imports at the top (after the recallInjection import):

```ts
import {
  type ConductContext,
  type ConductProvider,
  DEFAULT_CONDUCT_REFUSAL,
  wrapConductAuditSink,
} from './conductPort.js';
```

(b) Immediately AFTER the UserPromptSubmit block (after the closing `}` at line 154, BEFORE the `maybeFireStop` definition), insert:

```ts
  // Conduct seams (1b). preGate runs AFTER the UserPromptSubmit rewrite so it
  // sees the FINAL text — including the injected memory/recall prefix and any
  // hook rewrite; nothing smuggles past it via a rewriting hook (D23). 'user'
  // surface only; a thrown capability fails OPEN (fail-closed postures are the
  // engine's job, inside the capability). Audit events are content-free.
  const conduct = params.conduct;
  const conductCtx = params.conductCtx;
  const emitConductAudit = wrapConductAuditSink(conduct?.auditSink?.bind(conduct));
  if (conduct?.preGate && conductCtx && conductCtx.surface === 'user') {
    const gateText = latestUserText(history);
    if (gateText !== undefined) {
      const startedAt = Date.now();
      let verdictLabel = 'allow';
      try {
        const verdict = await conduct.preGate(gateText, conductCtx);
        verdictLabel = verdict.action;
        if (verdict.action === 'rewrite') {
          history = rewriteLatestUserText(history, verdict.text);
        } else if (verdict.action === 'deny') {
          emitConductAudit({
            stage: 'pregate',
            sessionId: conductCtx.sessionId,
            surface: conductCtx.surface,
            verdict: 'deny',
            latencyMs: Date.now() - startedAt,
            iso: nowIso(),
          });
          if (verdict.refusalText !== undefined) {
            const refusal = yield* yieldConductRefusal(verdict.refusalText);
            await fireStopHookIfBound();
            return refusal;
          }
          const terminal: Terminal = {
            reason: 'error',
            error: new Error('prompt rejected by conduct preGate'),
          };
          if (hookRunner && sessionId && cwd) {
            await fireStopHook(hookRunner, sessionId, cwd, terminal.reason, signal);
          }
          return terminal;
        }
      } catch {
        verdictLabel = 'error'; // fail open
      }
      if (verdictLabel !== 'deny') {
        emitConductAudit({
          stage: 'pregate',
          sessionId: conductCtx.sessionId,
          surface: conductCtx.surface,
          verdict: verdictLabel,
          latencyMs: Date.now() - startedAt,
          iso: nowIso(),
        });
      }
    }
  }
```

(c) Add the two helpers used above. `yieldConductRefusal` is a local generator delegate defined INSIDE `query()` (it needs `history` in scope), placed right before the conduct block; `fireStopHookIfBound` wraps the existing hook-firing guard:

```ts
  // Synthesize a refusal reply (preGate deny-with-text / triage refuse): the
  // turn COMPLETES with an assistant message — a refusal is a successful turn,
  // not an error. Mirrors the shape consumers already handle (assistant_message
  // event → the message itself is NOT re-yielded; hosts persist via the event,
  // matching createAgent's drive loop which collects assistant messages from
  // events only).
  function* yieldConductRefusal(text: string): Generator<StreamEvent, Terminal> {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text }],
    };
    history.push(message);
    yield { type: 'message_start' };
    yield { type: 'text_delta', text };
    yield { type: 'assistant_message', message };
    yield { type: 'message_stop', stop_reason: 'end_turn' };
    return { reason: 'completed' };
  }
  async function fireStopHookIfBound(): Promise<void> {
    if (hookRunner && sessionId && cwd) {
      await fireStopHook(hookRunner, sessionId, cwd, 'completed', signal);
    }
  }
```

Note: `AssistantMessage` is already imported in query.ts; `yield*` from an async generator over a sync generator is legal. Keep `history = rewriteLatestUserText(...)` — `history` is already a `let`.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/core/queryConduct.test.ts && bun test tests/core/query.test.ts`
Expected: PASS — new seam tests green AND the existing query suite untouched.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint`

```bash
git add packages/sdk/src/core/types.ts packages/sdk/src/core/query.ts tests/core/queryConduct.test.ts
git commit -m "feat(conduct): preGate seam in query() — post-rewrite placement, deny/rewrite/refusal semantics (1b task 3)"
```

---

### Task 4: Triage seam in query()

**Files:**
- Modify: `packages/sdk/src/core/query.ts` (insert triage right after the Task-3 preGate block)
- Test: `tests/core/queryConduct.test.ts` (append a describe block)

**Interfaces:**
- Consumes: Task 3's `conduct`/`conductCtx`/`emitConductAudit`/`yieldConductRefusal` locals; `TriageVerdict`, `DEFAULT_CONDUCT_REFUSAL` (Task 1).
- Produces: the complete input-side seam set in query(); nothing new for later tasks.

- [ ] **Step 1: Append the failing tests**

Append to `tests/core/queryConduct.test.ts`:

```ts
describe('query() triage seam', () => {
  test('triage refuse: pre-model short-circuit into a refusal reply (default text)', async () => {
    const seen = { requests: [] as Message[][] };
    const conduct: ConductProvider = {
      triage: () => ({ genuine: false, posture: 'refuse' }),
    };
    const { events, terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(seen.requests).toHaveLength(0);
    expect(terminal.reason).toBe('completed');
    const finals = events.filter(
      (e): e is Extract<StreamEvent, { type: 'assistant_message' }> =>
        'type' in e && e.type === 'assistant_message',
    );
    const block = finals[0]?.message.content[0];
    expect(block?.type === 'text' && block.text).toBe(DEFAULT_CONDUCT_REFUSAL);
  });

  test('triage non-refuse postures are advisory: turn proceeds; audit records the posture', async () => {
    const seen = { requests: [] as Message[][] };
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      triage: () => ({ genuine: true, posture: 'guarded' }),
      auditSink: (e) => audits.push(e),
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(seen.requests).toHaveLength(1);
    expect(audits.find((e) => e.stage === 'triage')?.verdict).toBe('guarded');
  });

  test('triage throw fails OPEN', async () => {
    const seen = { requests: [] as Message[][] };
    const conduct: ConductProvider = {
      triage: () => {
        throw new Error('triage exploded');
      },
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', seen),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: ctx,
      }),
    );
    expect(terminal.reason).toBe('completed');
    expect(seen.requests).toHaveLength(1);
  });

  test('internal surface: triage does not run', async () => {
    let called = false;
    const conduct: ConductProvider = {
      triage: () => {
        called = true;
        return { genuine: false, posture: 'refuse' };
      },
    };
    const { terminal } = await drain(
      query({
        provider: scriptedProvider('hi', { requests: [] }),
        model: 'test-model',
        messages: [userMsg('hello')],
        systemPrompt: [],
        maxTokens: 100,
        conduct,
        conductCtx: { ...ctx, surface: 'internal' },
      }),
    );
    expect(called).toBe(false);
    expect(terminal.reason).toBe('completed');
  });
});
```

- [ ] **Step 2: Run to verify the new block fails**

Run: `bun test tests/core/queryConduct.test.ts`
Expected: the four triage tests FAIL (refuse not short-circuiting); preGate tests still PASS.

- [ ] **Step 3: Implement the triage block**

In `packages/sdk/src/core/query.ts`, immediately after the Task-3 preGate block:

```ts
  // Conduct triage (D3): pre-generation intent assessment. Small-model,
  // posture-shaping, FAIL-OPEN by design; 'refuse' short-circuits pre-model
  // into a refusal reply. Non-refuse postures are advisory in 1b (audited;
  // the engine consumes them when it arrives).
  if (conduct?.triage && conductCtx && conductCtx.surface === 'user') {
    const triageText = latestUserText(history);
    if (triageText !== undefined) {
      const startedAt = Date.now();
      try {
        const verdict = await conduct.triage(triageText, conductCtx);
        const label = verdict.posture ?? (verdict.genuine ? 'open' : 'guarded');
        emitConductAudit({
          stage: 'triage',
          sessionId: conductCtx.sessionId,
          surface: conductCtx.surface,
          verdict: label,
          latencyMs: Date.now() - startedAt,
          iso: nowIso(),
        });
        if (verdict.posture === 'refuse') {
          const refusal = yield* yieldConductRefusal(
            verdict.refusalText ?? DEFAULT_CONDUCT_REFUSAL,
          );
          await fireStopHookIfBound();
          return refusal;
        }
      } catch {
        emitConductAudit({
          stage: 'triage',
          sessionId: conductCtx.sessionId,
          surface: conductCtx.surface,
          verdict: 'error',
          latencyMs: Date.now() - startedAt,
          iso: nowIso(),
        });
        // fail open
      }
    }
  }
```

- [ ] **Step 4: Run tests, typecheck, lint, commit**

Run: `bun test tests/core/queryConduct.test.ts tests/core/query.test.ts && bun run typecheck && bun run lint`
Expected: all PASS, clean.

```bash
git add packages/sdk/src/core/query.ts tests/core/queryConduct.test.ts
git commit -m "feat(conduct): pre-generation triage seam — fail-open, refuse short-circuit (1b task 4)"
```

---

### Task 5: createAgent conduct resolution + persona seam + null-provider contract

**Files:**
- Modify: `packages/sdk/src/agent/createAgent.ts`
- Test: `tests/agent/createAgent.conduct.test.ts`

**Interfaces:**
- Consumes: `ConductProvider`, `ConductContext`, `ConductSurface` (Task 1); `insertPersonaSegments` (Task 2); `QueryParams.conduct/conductCtx` (Task 3).
- Produces: `AgentConfig.conduct?: ConductProvider`, `AgentConfig.conductSurface?: ConductSurface`, `PerTurn.conduct?: ConductProvider` — the fields every wrapper surface (Tasks 9–10) threads. Persona audit event stage `'persona'`, verdict = segment count as string (content-free).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/agent/createAgent.conduct.test.ts — conduct wiring at the assembler:
// null-provider byte-identical contract, persona composition, ConductContext
// construction, per-turn override.

import { describe, expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type {
  ConductAuditEvent,
  ConductProvider,
} from '@yevgetman/sov-sdk/core/conductPort';
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemSegment,
} from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';

/** Scripted provider capturing the system prompt each stream() call receives. */
function scriptedProvider(seen: { systems: SystemSegment[][] }): LLMProvider {
  return {
    name: 'scripted',
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    async *stream(req: any): AsyncGenerator<StreamEvent> {
      seen.systems.push(req.system as SystemSegment[]);
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      };
      yield { type: 'message_start' };
      yield { type: 'assistant_message', message };
      yield { type: 'message_stop', stop_reason: 'end_turn' };
    },
  } as unknown as LLMProvider;
}

async function drainRun(gen: AsyncGenerator<StreamEvent | Message, unknown>) {
  const events: (StreamEvent | Message)[] = [];
  let result: unknown;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    events.push(step.value);
  }
  return { events, result };
}

const baseSegments: SystemSegment[] = [
  { text: 'base', cacheable: true },
  { text: 'dynamic', cacheable: false },
];

describe('createAgent conduct wiring', () => {
  test('null provider (absent conduct): system prompt reaches provider unchanged', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
    });
    await drainRun(agent.run('hello'));
    expect(seen.systems[0]).toEqual(baseSegments);
  });

  test('personaSegments compose after the cacheable prefix; audit fires with ctx fields', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      personaSegments: (ctx) => {
        expect(ctx.surface).toBe('user');
        expect(ctx.model).toBe('test-model');
        expect(ctx.providerName).toBe('scripted');
        expect(ctx.sessionId.length).toBeGreaterThan(0);
        return [{ text: 'persona', cacheable: true }];
      },
      auditSink: (e) => audits.push(e),
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct,
    });
    await drainRun(agent.run('hello'));
    expect(seen.systems[0]?.map((s) => s.text)).toEqual(['base', 'persona', 'dynamic']);
    expect(audits.find((e) => e.stage === 'persona')?.verdict).toBe('segments:1');
  });

  test("internal surface: personaSegments skipped ('user'-only)", async () => {
    const seen = { systems: [] as SystemSegment[][] };
    let called = false;
    const conduct: ConductProvider = {
      personaSegments: () => {
        called = true;
        return [{ text: 'persona', cacheable: true }];
      },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct,
      conductSurface: 'internal',
    });
    await drainRun(agent.run('hello'));
    expect(called).toBe(false);
    expect(seen.systems[0]).toEqual(baseSegments);
  });

  test('personaSegments throw fails OPEN (base prompt used)', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = {
      personaSegments: () => {
        throw new Error('persona exploded');
      },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct,
    });
    const { result } = await drainRun(agent.run('hello'));
    expect(seen.systems[0]).toEqual(baseSegments);
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).terminal.reason).toBe('completed');
  });

  test('perTurn.conduct overrides standing config', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const standing: ConductProvider = {
      personaSegments: () => [{ text: 'standing-persona', cacheable: true }],
    };
    const perTurn: ConductProvider = {
      personaSegments: () => [{ text: 'per-turn-persona', cacheable: true }],
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      systemPrompt: baseSegments,
      conduct: standing,
    });
    await drainRun(agent.run('hello', { conduct: perTurn }));
    expect(seen.systems[0]?.map((s) => s.text)).toEqual([
      'base',
      'per-turn-persona',
      'dynamic',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/agent/createAgent.conduct.test.ts`
Expected: FAIL — `conduct`/`conductSurface` unknown on AgentConfig.

- [ ] **Step 3: Implement in createAgent.ts**

(a) Imports:

```ts
import {
  type ConductContext,
  type ConductProvider,
  type ConductSurface,
  wrapConductAuditSink,
} from '../core/conductPort.js';
import { insertPersonaSegments } from '../core/conductSegments.js';
```

(b) `AgentConfig` — after the `traceRecorder` field:

```ts
  /** Conduct Port (1b) — optional agent-behavior governance provider. Absent →
   *  null provider: byte-identical behavior on every seam. */
  conduct?: ConductProvider;
  /** Which surface this agent's turns are (D23): 'user' (default) runs the
   *  full seam set; 'internal' (harness-driven sub-turns) keeps only the
   *  floors — toolPolicy + outputGuard; persona/preGate/triage are skipped. */
  conductSurface?: ConductSurface;
```

(c) `PerTurn` — add one line to the Partial:

```ts
  conduct: ConductProvider;
```

(d) In `run()`, after step 4 (`const systemPrompt = toSystemSegments(...)`, line ~238), insert:

```ts
    // 4b. Conduct (1b): resolve provider + build the per-turn ConductContext.
    //     personaSegments compose into the system prompt here — after the
    //     cacheable prefix, before the dynamic tail (see insertPersonaSegments)
    //     — so EVERY turn driver gets persona projection through this one
    //     assembler. 'user' surface only; a throw fails OPEN (base prompt).
    const conduct = perTurn.conduct ?? config.conduct;
    const conductSurface: ConductSurface = config.conductSurface ?? 'user';
    const conductCtx: ConductContext = {
      sessionId,
      surface: conductSurface,
      model,
      providerName: provider.name,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    };
    const emitConductAudit = wrapConductAuditSink(conduct?.auditSink?.bind(conduct));
    let effectiveSystemPrompt = systemPrompt;
    if (conduct?.personaSegments && conductSurface === 'user') {
      const startedAt = Date.now();
      try {
        const persona = await conduct.personaSegments(conductCtx);
        effectiveSystemPrompt = insertPersonaSegments(systemPrompt, persona);
        emitConductAudit({
          stage: 'persona',
          sessionId,
          surface: conductSurface,
          verdict: `segments:${persona.length}`,
          latencyMs: Date.now() - startedAt,
          iso: new Date().toISOString(),
        });
      } catch {
        emitConductAudit({
          stage: 'persona',
          sessionId,
          surface: conductSurface,
          verdict: 'error',
          latencyMs: Date.now() - startedAt,
          iso: new Date().toISOString(),
        });
      }
    }
```

(e) In the `query({...})` call: change `systemPrompt,` to `systemPrompt: effectiveSystemPrompt,` and add the conduct threading:

```ts
      ...(conduct !== undefined ? { conduct, conductCtx } : {}),
```

(f) Persistence: `persistTurn` receives `systemPrompt: effectiveSystemPrompt` (the prompt actually used).

- [ ] **Step 4: Run tests + the full agent suite**

Run: `bun test tests/agent/ tests/core/ && bun run typecheck && bun run lint`
Expected: all PASS (existing createAgent tests prove the null-provider contract).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/agent/createAgent.ts tests/agent/createAgent.conduct.test.ts
git commit -m "feat(conduct): createAgent conduct resolution + persona-segment seam (1b task 5)"
```

---

### Task 6: toolPolicy composition (deny-first wrapper)

**Files:**
- Create: `packages/sdk/src/core/conductToolPolicy.ts`
- Modify: `packages/sdk/src/agent/createAgent.ts` (compose before threading `canUseTool`)
- Test: `tests/core/conductToolPolicy.test.ts`

**Interfaces:**
- Consumes: `ConductProvider`, `ConductContext`, `wrapConductAuditSink` (Task 1); `CanUseTool`, `ResolvedPermissionResult` from `../permissions/types.js`.
- Produces: `composeConductCanUseTool(conduct, ctx, inner?) => CanUseTool | undefined` — identity passthrough (returns `inner` as-is, same reference) when the provider has no `toolPolicy`.

Semantics (the channel-wrapper precedent, `src/channels/permission.ts`): conduct `deny` wins outright and the inner decider is never consulted; any non-deny defers to the inner decider unchanged; no inner decider + non-deny → allow (preserving today's ungated default). Runs on EVERY surface (floors). A throw fails open (defer to inner).

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/conductToolPolicy.test.ts
import { describe, expect, test } from 'bun:test';
import type { ConductContext, ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import { composeConductCanUseTool } from '@yevgetman/sov-sdk/core/conductToolPolicy';
import type { CanUseTool } from '@yevgetman/sov-sdk/permissions/types';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';

const ctx: ConductContext = {
  sessionId: 's1',
  surface: 'user',
  model: 'm',
  providerName: 'p',
};
const fakeTool = { name: 'Bash' } as unknown as Tool<unknown, unknown>;
const toolCtx = { cwd: '/tmp', sessionId: 's1' } as unknown as ToolContext;

describe('composeConductCanUseTool', () => {
  test('no toolPolicy capability: returns the inner decider UNCHANGED (same reference)', () => {
    const inner: CanUseTool = async () => ({ behavior: 'allow' });
    expect(composeConductCanUseTool({}, ctx, inner)).toBe(inner);
    expect(composeConductCanUseTool(undefined, ctx, inner)).toBe(inner);
    expect(composeConductCanUseTool({}, ctx, undefined)).toBeUndefined();
  });

  test('conduct deny wins; inner never consulted', async () => {
    let innerCalled = false;
    const inner: CanUseTool = async () => {
      innerCalled = true;
      return { behavior: 'allow' };
    };
    const conduct: ConductProvider = {
      toolPolicy: (toolName) =>
        toolName === 'Bash'
          ? { behavior: 'deny', reason: 'conduct: shell blocked' }
          : { behavior: 'allow' },
    };
    const composed = composeConductCanUseTool(conduct, ctx, inner);
    const verdict = await composed?.(fakeTool, { cmd: 'ls' }, toolCtx);
    expect(verdict).toEqual({ behavior: 'deny', reason: 'conduct: shell blocked' });
    expect(innerCalled).toBe(false);
  });

  test('conduct allow defers to the inner decider', async () => {
    const inner: CanUseTool = async () => ({ behavior: 'deny', reason: 'inner said no' });
    const conduct: ConductProvider = { toolPolicy: () => ({ behavior: 'allow' }) };
    const composed = composeConductCanUseTool(conduct, ctx, inner);
    const verdict = await composed?.(fakeTool, {}, toolCtx);
    expect(verdict).toEqual({ behavior: 'deny', reason: 'inner said no' });
  });

  test('no inner decider + non-deny → allow (ungated default preserved)', async () => {
    const conduct: ConductProvider = { toolPolicy: () => ({ behavior: 'allow' }) };
    const composed = composeConductCanUseTool(conduct, ctx, undefined);
    const verdict = await composed?.(fakeTool, {}, toolCtx);
    expect(verdict).toEqual({ behavior: 'allow' });
  });

  test('toolPolicy throw fails open (defers to inner)', async () => {
    const inner: CanUseTool = async () => ({ behavior: 'allow' });
    const conduct: ConductProvider = {
      toolPolicy: () => {
        throw new Error('policy exploded');
      },
    };
    const composed = composeConductCanUseTool(conduct, ctx, inner);
    const verdict = await composed?.(fakeTool, {}, toolCtx);
    expect(verdict).toEqual({ behavior: 'allow' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/core/conductToolPolicy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/sdk/src/core/conductToolPolicy.ts — deny-first conduct wrapper
// around the canUseTool cascade (the channel-wrapper composition precedent:
// src/channels/permission.ts). Conduct 'deny' wins outright; any non-deny
// defers to the inner decider unchanged; absent inner + non-deny allows
// (today's ungated default). Runs on EVERY surface — tool floors apply to
// internal turns too (D23). A thrown toolPolicy fails OPEN (defer to inner).

import type { CanUseTool } from '../permissions/types.js';
import { type ConductContext, type ConductProvider, wrapConductAuditSink } from './conductPort.js';

export function composeConductCanUseTool(
  conduct: ConductProvider | undefined,
  ctx: ConductContext,
  inner: CanUseTool | undefined,
): CanUseTool | undefined {
  const policy = conduct?.toolPolicy?.bind(conduct);
  if (!policy) return inner;
  const emitAudit = wrapConductAuditSink(conduct?.auditSink?.bind(conduct));
  return async (tool, input, toolCtx) => {
    const startedAt = Date.now();
    let verdictLabel = 'allow';
    try {
      const verdict = await policy(tool.name, input, ctx);
      if (verdict.behavior === 'deny') {
        verdictLabel = 'deny';
        return {
          behavior: 'deny',
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
        };
      }
    } catch {
      verdictLabel = 'error'; // fail open → defer to inner
    } finally {
      emitAudit({
        stage: 'tool',
        sessionId: ctx.sessionId,
        surface: ctx.surface,
        verdict: verdictLabel,
        latencyMs: Date.now() - startedAt,
        iso: new Date().toISOString(),
      });
    }
    if (inner) return inner(tool, input, toolCtx);
    return { behavior: 'allow' };
  };
}
```

- [ ] **Step 4: Wire into createAgent**

In `createAgent.ts` `run()`, the `query({...})` call currently threads `...(perTurn.canUseTool !== undefined ? { canUseTool: perTurn.canUseTool } : {})`. Replace with (placed after the Task-5 conduct block so `conduct`/`conductCtx` are in scope):

```ts
    // 7b. Conduct tool policy (floors — every surface): deny-first wrapper
    //     around the per-turn canUseTool. Identity passthrough when the
    //     provider has no toolPolicy capability.
    const canUseTool = composeConductCanUseTool(conduct, conductCtx, perTurn.canUseTool);
```

and in the `query({...})` spread: `...(canUseTool !== undefined ? { canUseTool } : {})`.

Add the import: `import { composeConductCanUseTool } from '../core/conductToolPolicy.js';`

- [ ] **Step 5: Run tests, typecheck, lint, commit**

Run: `bun test tests/core/conductToolPolicy.test.ts tests/agent/ && bun run typecheck && bun run lint`
Expected: PASS; existing per-turn canUseTool tests in createAgent.test.ts confirm the identity passthrough.

```bash
git add packages/sdk/src/core/conductToolPolicy.ts packages/sdk/src/agent/createAgent.ts tests/core/conductToolPolicy.test.ts
git commit -m "feat(conduct): deny-first toolPolicy composition on the canUseTool cascade (1b task 6)"
```

---

### Task 7: Output-delivery gate in the createAgent drive loop

**Files:**
- Create: `packages/sdk/src/core/conductOutput.ts` (text-block substitution helper)
- Modify: `packages/sdk/src/agent/createAgent.ts` (drive loop, step 8)
- Test: `tests/agent/createAgent.conduct.test.ts` (append) + `tests/core/conductOutput.test.ts`

**Interfaces:**
- Consumes: `ConductOutputGuard`, `OutputFinalVerdict`, `DEFAULT_CONDUCT_REFUSAL` (Task 1).
- Produces: `substituteAssistantText(message: AssistantMessage, text: string): AssistantMessage` — replaces ALL text blocks with one text block carrying `text`, PRESERVING tool_use/thinking blocks in order. Used by the drive loop; later by the decorum adapter.

Gate semantics (SDK-thin; the governor logic arrives with the engine in 1d):
- `text_delta` events route through `onDelta` when present: `''` → the event is dropped (held); changed text → re-emitted with the released text. All other events pass through untouched.
- Every `assistant_message` event routes through `onFinal` when present: `pass` → unchanged; `replace` → text blocks substituted with `verdict.text`; `block` → substituted with `template ?? DEFAULT_CONDUCT_REFUSAL`. The SUBSTITUTED message is what gets yielded, counted (`finalAssistant`), pushed to `messages[]`, and therefore persisted — history-scrub-before-persistence by construction. tool_use blocks are preserved verbatim (adjacency with tool_results in the transcript is never broken).
- Runs on EVERY surface (floors on internal turns too). `onFinal` throw fails open (original message); `onDelta` throw fails open (original delta).

- [ ] **Step 1: Write the failing substitution-helper test**

```ts
// tests/core/conductOutput.test.ts
import { describe, expect, test } from 'bun:test';
import { substituteAssistantText } from '@yevgetman/sov-sdk/core/conductOutput';
import type { AssistantMessage } from '@yevgetman/sov-sdk/core/types';

describe('substituteAssistantText', () => {
  test('replaces text blocks with one substituted block; preserves tool_use order', () => {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'leaky secret' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
        { type: 'text', text: 'more leak' },
      ],
    };
    const out = substituteAssistantText(message, '[withheld]');
    expect(out.content).toEqual([
      { type: 'text', text: '[withheld]' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
    ]);
    // Original untouched (immutability).
    expect(message.content).toHaveLength(3);
  });

  test('message with no text blocks gains one leading text block', () => {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
    };
    const out = substituteAssistantText(message, '[withheld]');
    expect(out.content[0]).toEqual({ type: 'text', text: '[withheld]' });
    expect(out.content[1]?.type).toBe('tool_use');
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement the helper**

Run: `bun test tests/core/conductOutput.test.ts` → FAIL (module not found).

```ts
// packages/sdk/src/core/conductOutput.ts — output-gate substitution helper.
//
// A replace/block verdict substitutes a message's TEXT content while
// preserving tool_use (and thinking) blocks verbatim — replacing tool_use
// blocks would orphan the tool_result blocks already in the transcript
// (Anthropic rejects tool_use without an adjacent matching tool_result).
// The FIRST text block becomes the substituted text; remaining text blocks
// are dropped; non-text blocks keep their positions. A message with no text
// block gains one leading text block.

import type { AssistantMessage } from './types.js';

export function substituteAssistantText(
  message: AssistantMessage,
  text: string,
): AssistantMessage {
  let substituted = false;
  const content: AssistantMessage['content'] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      if (!substituted) {
        content.push({ type: 'text', text });
        substituted = true;
      }
      // subsequent text blocks are dropped
    } else {
      content.push(block);
    }
  }
  if (!substituted) content.unshift({ type: 'text', text });
  return { role: 'assistant', content };
}
```

Run: `bun test tests/core/conductOutput.test.ts` → PASS.

- [ ] **Step 3: Append the failing drive-loop tests**

Append to `tests/agent/createAgent.conduct.test.ts`:

```ts
describe('createAgent output gate', () => {
  test('onFinal replace: yielded event, finalAssistant, and messages[] all carry the substitution', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = {
      outputGuard: {
        onFinal: () => ({ action: 'replace', text: '[rewritten]' }),
      },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      conduct,
    });
    const { events, result } = await drainRun(agent.run('hello'));
    const finals = events.filter(
      (e): e is Extract<StreamEvent, { type: 'assistant_message' }> =>
        'type' in e && e.type === 'assistant_message',
    );
    const block = finals[0]?.message.content[0];
    expect(block?.type === 'text' && block.text).toBe('[rewritten]');
    // biome-ignore lint/suspicious/noExplicitAny: structural checks
    const r = result as any;
    expect(r.finalAssistant.content[0].text).toBe('[rewritten]');
    const lastMsg = r.messages[r.messages.length - 1];
    expect(lastMsg.content[0].text).toBe('[rewritten]'); // scrub-before-persistence
  });

  test('onFinal block without template: DEFAULT_CONDUCT_REFUSAL substituted', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = { outputGuard: { onFinal: () => ({ action: 'block' }) } };
    const agent = createAgent({ provider: scriptedProvider(seen), model: 'test-model', conduct });
    const { result } = await drainRun(agent.run('hello'));
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).finalAssistant.content[0].text).toBe(DEFAULT_CONDUCT_REFUSAL);
  });

  test('onDelta hold + release: held deltas are dropped from the yielded stream', async () => {
    const provider: LLMProvider = {
      name: 'scripted',
      async *stream(): AsyncGenerator<StreamEvent> {
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'abc' }],
        };
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'a' };
        yield { type: 'text_delta', text: 'b' };
        yield { type: 'text_delta', text: 'c' };
        yield { type: 'assistant_message', message };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
      },
    } as unknown as LLMProvider;
    const conduct: ConductProvider = {
      outputGuard: { onDelta: (text) => (text === 'b' ? '' : text) },
    };
    const agent = createAgent({ provider, model: 'test-model', conduct });
    const { events } = await drainRun(agent.run('hello'));
    const deltas = events
      .filter(
        (e): e is Extract<StreamEvent, { type: 'text_delta' }> =>
          'type' in e && e.type === 'text_delta',
      )
      .map((e) => e.text);
    expect(deltas).toEqual(['a', 'c']);
  });

  test("outputGuard runs on 'internal' surface too (floors everywhere)", async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = {
      outputGuard: { onFinal: () => ({ action: 'replace', text: '[floored]' }) },
    };
    const agent = createAgent({
      provider: scriptedProvider(seen),
      model: 'test-model',
      conduct,
      conductSurface: 'internal',
    });
    const { result } = await drainRun(agent.run('hello'));
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).finalAssistant.content[0].text).toBe('[floored]');
  });

  test('onFinal throw fails open: original message flows', async () => {
    const seen = { systems: [] as SystemSegment[][] };
    const conduct: ConductProvider = {
      outputGuard: {
        onFinal: () => {
          throw new Error('guard exploded');
        },
      },
    };
    const agent = createAgent({ provider: scriptedProvider(seen), model: 'test-model', conduct });
    const { result } = await drainRun(agent.run('hello'));
    // biome-ignore lint/suspicious/noExplicitAny: structural check
    expect((result as any).finalAssistant.content[0].text).toBe('ok');
  });
});
```

Add `DEFAULT_CONDUCT_REFUSAL` to the conductPort import at the top of the test file.

- [ ] **Step 4: Run to verify the new block fails, then implement the gate**

Run: `bun test tests/agent/createAgent.conduct.test.ts` → the five output-gate tests FAIL.

In `createAgent.ts` step 8's drive loop, inside `if ('type' in ev) { ... }` — insert BEFORE the existing `usageAcc = accumulateUsage(...)` line a gate block, so the substituted event is what the accounting and yield both see:

```ts
          // Conduct output gate (1b — floors on every surface). Deltas route
          // through onDelta ('' = held → event dropped); assistant messages
          // route through onFinal (pass/replace/block). The SUBSTITUTED
          // message is what is yielded, counted, and persisted — the
          // history-scrub-before-persistence guarantee. Throws fail OPEN.
          const guard = conduct?.outputGuard;
          if (guard?.onDelta && ev.type === 'text_delta') {
            let released = ev.text;
            try {
              released = guard.onDelta(ev.text, conductCtx);
            } catch {
              // fail open — original delta flows
            }
            if (released.length === 0) continue;
            if (released !== ev.text) ev = { type: 'text_delta', text: released };
          }
          if (guard?.onFinal && ev.type === 'assistant_message') {
            const startedAt = Date.now();
            let verdictLabel = 'pass';
            try {
              const verdict = await guard.onFinal(ev.message, conductCtx);
              verdictLabel = verdict.action;
              if (verdict.action === 'replace') {
                ev = {
                  type: 'assistant_message',
                  message: substituteAssistantText(ev.message, verdict.text),
                };
              } else if (verdict.action === 'block') {
                ev = {
                  type: 'assistant_message',
                  message: substituteAssistantText(
                    ev.message,
                    verdict.template ?? DEFAULT_CONDUCT_REFUSAL,
                  ),
                };
              }
            } catch {
              verdictLabel = 'error'; // fail open
            }
            emitConductAudit({
              stage: 'output',
              sessionId,
              surface: conductSurface,
              verdict: verdictLabel,
              latencyMs: Date.now() - startedAt,
              iso: new Date().toISOString(),
            });
          }
```

Notes: `ev` is currently a `const` from `step.value` — change `const ev = step.value;` to `let ev = step.value;`. Add imports: `substituteAssistantText` from `../core/conductOutput.js`, `DEFAULT_CONDUCT_REFUSAL` added to the conductPort import.

- [ ] **Step 5: Run the full suite**

Run: `bun test && bun run typecheck && bun run lint`
Expected: entire suite green (~4300+ pass) — the null-provider invariant proof for the input+output seams together.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/core/conductOutput.ts packages/sdk/src/agent/createAgent.ts tests/core/conductOutput.test.ts tests/agent/createAgent.conduct.test.ts
git commit -m "feat(conduct): output-delivery gate in the createAgent drive loop — hold/replace/block + scrub-before-persistence (1b task 7)"
```

---

### Task 8: Surface-discriminator documentation + subprocess trust boundary

**Files:**
- Modify: `packages/sdk/src/core/conductPort.ts` (docstring only — already drafted in Task 1; verify)
- Modify: `src/tasks/manager.ts` (comment at the subprocess spawn site)
- Test: covered by Task 3/4/5/7 surface tests (no new test)

The 'user'/'internal' mechanics are already implemented and tested (Tasks 3–7). This task pins the one NON-mechanical finding: **sub-agents in this architecture run as subprocesses** (`src/tasks/manager.ts` spawns `sov drive` children) — an in-process ConductProvider object cannot cross that boundary. Their conduct binding happens in the CHILD process's own runtime (Task 9's wiring applies when the child boots). This is a named trust boundary (spec D23 note), not a bypass.

- [ ] **Step 1: Verify the conductPort.ts docstring names the subprocess boundary** (Task 1's header includes it — confirm the paragraph beginning "NOTE: sub-agents that run as SUBPROCESSES").

- [ ] **Step 2: Add the pointer comment in src/tasks/manager.ts**

At the top-of-file comment block (after the existing header paragraph), add:

```ts
// Conduct (1b): child `sov drive` subprocesses do NOT inherit the parent's
// in-process ConductProvider — a provider object cannot cross a process
// boundary. A child binds its own provider from its own runtime config at
// boot (src/server/runtime.ts wiring). Named trust boundary, spec D23.
```

- [ ] **Step 3: Typecheck, lint, commit**

Run: `bun run typecheck && bun run lint`

```bash
git add packages/sdk/src/core/conductPort.ts src/tasks/manager.ts
git commit -m "docs(conduct): name the subprocess conduct trust boundary (1b task 8)"
```

---

### Task 9: Wrapper binding — runtime + SessionContext + gateway (turns.ts) + perTurnInstructions gating

**Files:**
- Modify: `src/server/runtime.ts` (a `conduct?: ConductProvider` field on the runtime object; grep `systemSegments` in the runtime-build return to find the field block)
- Modify: `src/server/sessionContext.ts` (SessionContext gains `conduct?: ConductProvider`; buildSessionContext threads `runtime.conduct`)
- Modify: `src/server/routes/turns.ts` (thread into createAgent config; gate perTurnInstructions)
- Test: `tests/server/turnsConduct.test.ts`

**Interfaces:**
- Consumes: `ConductProvider`, `ConductContext` (via `@yevgetman/sov-sdk/core/conductPort`); `AgentConfig.conduct` (Task 5).
- Produces: `runtime.conduct?: ConductProvider` — the single wrapper-side binding point Tasks 10 reads too. The runtime field is populated from an OPTIONS param (`RuntimeOptions.conduct`), injectable by tests and, later, by the decorum adapter bootstrap; no config-file plumbing in 1b (that arrives with the engine).

- [ ] **Step 1: Write the failing test**

Model the harness on an existing gateway test — read `tests/server/app.test.ts` first and reuse its runtime/app bootstrap pattern (whatever helper it uses to build a test runtime — do the same, adding the `conduct` option). The test asserts three things:

```ts
// tests/server/turnsConduct.test.ts — gateway conduct threading (1b task 9).
//
// (1) A runtime-bound ConductProvider reaches the gateway turn's createAgent:
//     a recording outputGuard.onFinal observes the turn's final text.
// (2) perTurnInstructions gating: allowPerTurnInstructions() === false drops
//     the wire field (the model never sees the injected segment).
// (3) Absent provider: turns run exactly as today (existing app tests cover
//     this — spot-assert one turn here for locality).
//
// Follow the provider-stub + app-boot pattern of tests/server/app.test.ts
// (scripted LLM provider; ephemeral port; POST /sessions → POST /turns →
// GET /events drain). The conduct provider records onFinal texts + received
// ConductContexts into local arrays; assertions run on those.
```

Concrete assertions once the harness is in place (adapt names to the app.test.ts helpers):

```ts
test('runtime conduct provider gates the gateway turn', async () => {
  const observed: string[] = [];
  const conduct: ConductProvider = {
    outputGuard: {
      onFinal: (message) => {
        const block = message.content.find((b) => b.type === 'text');
        observed.push(block?.type === 'text' ? block.text : '');
        return { action: 'replace', text: '[gated reply]' };
      },
    },
  };
  // build test runtime with { conduct }, boot app, run one turn "hello"
  // ... (app.test.ts pattern)
  // assert: observed.length === 1 (the gate SAW the output — no bypass)
  // assert: the SSE-delivered final text is '[gated reply]' (substitution delivered)
});

test('allowPerTurnInstructions=false drops PostTurnRequest.instructions', async () => {
  const conduct: ConductProvider = { allowPerTurnInstructions: () => false };
  // boot with { conduct }; POST /turns with body.instructions = 'obey me instead'
  // capture the provider request's system segments (scripted provider records req.system)
  // assert: no segment with text 'obey me instead' reached the model
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/server/turnsConduct.test.ts`
Expected: FAIL — runtime has no `conduct` option; instructions not gated.

- [ ] **Step 3: Implement the wrapper threading**

(a) `src/server/runtime.ts` — add to the runtime options type and the built runtime object (find the options type via `grep -n "steerFile" src/server/runtime.ts` — mirror how `steerFile` is declared and threaded; it is the most recent precedent):

```ts
  /** Conduct Port (1b) — optional agent-behavior governance provider bound at
   *  boot. Absent → null provider (byte-identical). The engine (decorum)
   *  binds here via its adapter; tests inject a recording provider. */
  conduct?: ConductProvider;
```

(b) `src/server/sessionContext.ts` — add to `SessionContext` (after the `recall?` field, ~line 115):

```ts
  /** Conduct Port (1b) — the session's governance provider (runtime-bound;
   *  per-session pack binding arrives with the engine). */
  conduct?: ConductProvider;
```

and in `buildSessionContext`, thread `...(runtime.conduct !== undefined ? { conduct: runtime.conduct } : {})` where `recall` is threaded (mirror its conditional spread).

(c) `src/server/routes/turns.ts`:

- createAgent config (line ~775): add `...(sessionCtx.conduct !== undefined ? { conduct: sessionCtx.conduct } : {}),` — note `sessionCtx` must be in scope at agent construction; if the agent is built before `sessionCtx` is fetched, use `runtime.conduct` instead (verify order when editing; the standing config reads runtime refs, so `runtime.conduct` is the safer anchor — use it).
- perTurnInstructions gating (line ~295, where `perTurnInstructions` is derived): after the existing derivation, add:

```ts
    // Conduct gate (D23): a bound provider may veto the per-turn instruction
    // wire field (a regulated pack disables client-appended system segments).
    // Applied at the wire boundary so the dropped field never reaches the
    // PerTurn systemPrompt assembly below.
    const conductForGate = runtime.conduct;
    const instructionsAllowed =
      conductForGate?.allowPerTurnInstructions === undefined ||
      conductForGate.allowPerTurnInstructions({
        sessionId,
        surface: 'user',
        model: runtime.model,
        providerName: runtime.resolvedProvider.transport.name,
        ...(runtime.cwd !== undefined ? { cwd: runtime.cwd } : {}),
      });
    const gatedPerTurnInstructions = instructionsAllowed ? perTurnInstructions : undefined;
```

and pass `gatedPerTurnInstructions` (not `perTurnInstructions`) to `runTurnInBackground`.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/server/turnsConduct.test.ts tests/server/app.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime.ts src/server/sessionContext.ts src/server/routes/turns.ts tests/server/turnsConduct.test.ts
git commit -m "feat(conduct): gateway binding — runtime provider, SessionContext threading, perTurnInstructions gate (1b task 9)"
```

---

### Task 10: Wrapper binding — channels, cron, OpenAI-compat, missionRun

**Files:**
- Modify: `src/channels/pipeline.ts` (thread `conduct` into `buildChannelAgentConfig`)
- Modify: `src/cron/wiring.ts` (thread into `buildCronAgentConfig`, line ~340)
- Modify: `src/openai/routes/chatCompletions.ts` (thread into its createAgent config, ~line 298)
- Modify: `src/cli/missionRun.ts` (thread into its createAgent config, line ~253)
- Test: `tests/channels/pipelineConduct.test.ts`, `tests/cron/wiringConduct.test.ts` (follow the reseat-test precedents: `tests/channels/pipeline.reseat.test.ts`, `tests/cron/wiring.reseat.test.ts`)

**Interfaces:**
- Consumes: `AgentConfig.conduct` (Task 5); each surface's existing deps/config shape (each already receives runtime-level fields like `memoryManager`/`recall` — `conduct` rides the same path from `runtime.conduct` / the surface's deps object).
- Produces: every user-facing in-process surface threads the provider; combined with Task 9, all six createAgent call sites are covered (subprocessExecutor = the subprocess boundary named in Task 8; machine contract = a gateway client, covered by Task 9).

- [ ] **Step 1: Write the failing threading tests**

Follow `tests/cron/wiring.recall.test.ts` (the exact precedent: it asserts recall threading through buildCronAgentConfig). For each surface, assert: with a `conduct` provider in the surface's deps, the constructed AgentConfig contains it; without, the field is absent. Example for cron (adapt to the actual builder signature after reading it):

```ts
// tests/cron/wiringConduct.test.ts
import { describe, expect, test } from 'bun:test';
import type { ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import { buildCronAgentConfig } from '../../src/cron/wiring.js'; // match the import style of wiring.recall.test.ts

describe('cron conduct threading', () => {
  test('a deps-supplied conduct provider lands on the AgentConfig; absent stays absent', () => {
    const conduct: ConductProvider = {};
    // build the minimal deps object wiring.recall.test.ts uses, plus conduct
    // const cfgWith = buildCronAgentConfig({ ...minimalDeps, conduct });
    // const cfgWithout = buildCronAgentConfig({ ...minimalDeps });
    // expect(cfgWith.conduct).toBe(conduct);
    // expect('conduct' in cfgWithout).toBe(false);
  });
});
```

Mirror for channels (`buildChannelAgentConfig` — see `tests/channels/pipeline.reseat.test.ts` for its deps shape). For chatCompletions and missionRun, the createAgent call is inline (no builder fn) — cover them in Task 12's coverage test instead of unit tests here; note that in the test file header.

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/cron/wiringConduct.test.ts tests/channels/pipelineConduct.test.ts`
Expected: FAIL — builders don't accept/thread `conduct`.

- [ ] **Step 3: Implement the four threadings**

Pattern per surface (mirror EXACTLY how `recall` is threaded at each site — conditional spread from the surface's deps/runtime):

- `src/cron/wiring.ts`: add `conduct?: ConductProvider` to the `buildCronAgentConfig` input type + `...(deps.conduct !== undefined ? { conduct: deps.conduct } : {})` in the returned AgentConfig; at the call site (~line 340), pass `...(runtime.conduct !== undefined ? { conduct: runtime.conduct } : {})`.
- `src/channels/pipeline.ts`: same shape through `buildChannelAgentConfig` and its deps.
- `src/openai/routes/chatCompletions.ts`: add to the inline createAgent config: `...(runtime.conduct !== undefined ? { conduct: runtime.conduct } : {})`.
- `src/cli/missionRun.ts`: missionRun builds its own runtime-ish deps — thread a `conduct` option the same way it receives its provider/tools (read lines ~200–260 first; if no runtime object exists there, add `conduct` to its options type, default absent).

- [ ] **Step 4: Run tests + full suite, typecheck, lint**

Run: `bun test tests/cron/ tests/channels/ && bun test && bun run typecheck && bun run lint`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/cron/wiring.ts src/channels/pipeline.ts src/openai/routes/chatCompletions.ts src/cli/missionRun.ts tests/cron/wiringConduct.test.ts tests/channels/pipelineConduct.test.ts
git commit -m "feat(conduct): thread the provider through channels, cron, openai-compat, missionRun (1b task 10)"
```

---

### Task 11: decorum native-adapter skeleton (wrapper side)

**Files:**
- Create: `src/conduct/decorumAdapter.ts`
- Test: `tests/conduct/decorumAdapter.test.ts`

**Interfaces:**
- Consumes: `ConductProvider` (via `@yevgetman/sov-sdk/core/conductPort`).
- Produces: `createDecorumAdapter(options?: DecorumAdapterOptions): ConductProvider` — the binding point the decorum engine (separate repo, `~/code/decorum`, npm `@yevgetman/decorum`) implements against in 1c+. In 1b it returns an inert provider (no capabilities) and documents the wiring contract.

- [ ] **Step 1: Write the failing test**

```ts
// tests/conduct/decorumAdapter.test.ts
import { describe, expect, test } from 'bun:test';
import { createDecorumAdapter } from '../../src/conduct/decorumAdapter.js';

describe('decorum adapter skeleton', () => {
  test('returns a valid, INERT ConductProvider (no capabilities yet)', () => {
    const provider = createDecorumAdapter();
    expect(provider.personaSegments).toBeUndefined();
    expect(provider.preGate).toBeUndefined();
    expect(provider.triage).toBeUndefined();
    expect(provider.toolPolicy).toBeUndefined();
    expect(provider.outputGuard).toBeUndefined();
    expect(provider.allowPerTurnInstructions).toBeUndefined();
    expect(provider.auditSink).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `bun test tests/conduct/decorumAdapter.test.ts` → FAIL (module not found).

```ts
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
```

- [ ] **Step 3: Run test, typecheck, lint, commit**

Run: `bun test tests/conduct/decorumAdapter.test.ts && bun run typecheck && bun run lint`

```bash
git add src/conduct/decorumAdapter.ts tests/conduct/decorumAdapter.test.ts
git commit -m "feat(conduct): decorum native-adapter skeleton + wiring contract (1b task 11)"
```

---

### Task 12: No-bypass coverage test, CHANGELOG, architecture doc

**Files:**
- Test: `tests/conduct/seamCoverage.test.ts`
- Modify: `CHANGELOG.md` (new top entry)
- Create: `docs/02-architecture/conduct-port.md`
- Modify: `docs/Documentation_Table_Of_Contents.md` (one line, in the 02-architecture section)

**Interfaces:** consumes everything shipped in Tasks 1–11; produces the 1b exit-bar evidence.

- [ ] **Step 1: Write the seam-coverage test**

```ts
// tests/conduct/seamCoverage.test.ts — the no-bypass proof (spec §8).
//
// Layer 1 (mechanical): every wrapper createAgent call site threads conduct.
// The six call sites are enumerated; each is asserted either by the unit
// tests of Tasks 9–10 (gateway, channels, cron) or here by source assertion
// (chatCompletions, missionRun — inline configs), with subprocessExecutor
// covered by the Task-8 trust-boundary doc (a provider object cannot cross a
// process boundary; the child binds its own at boot).
//
// Layer 2 (behavioral): one end-to-end gateway turn with a recording provider
// asserts the full seam chain fired in order: pregate → triage → persona →
// output (audit events), and the delivered text matches the gate's verdict —
// already exercised in tests/server/turnsConduct.test.ts; here we assert the
// AUDIT ORDER contract on a direct createAgent run (surface-independent).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type {
  ConductAuditEvent,
  ConductProvider,
} from '@yevgetman/sov-sdk/core/conductPort';
// reuse the scriptedProvider/drainRun helpers — copy the ~30 lines from
// tests/agent/createAgent.conduct.test.ts (tests do not import tests).

const WRAPPER_CALL_SITES = [
  'src/server/routes/turns.ts',
  'src/channels/pipeline.ts',
  'src/cron/wiring.ts',
  'src/openai/routes/chatCompletions.ts',
  'src/cli/missionRun.ts',
] as const;

describe('conduct seam coverage', () => {
  test('every user-facing wrapper createAgent call site threads conduct', () => {
    for (const file of WRAPPER_CALL_SITES) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes('conduct'), `${file} must thread the conduct provider`).toBe(true);
    }
  });

  test('audit chain order on a full gated turn: pregate → triage → persona → output', async () => {
    const audits: ConductAuditEvent[] = [];
    const conduct: ConductProvider = {
      personaSegments: () => [{ text: 'p', cacheable: true }],
      preGate: () => ({ action: 'allow' }),
      triage: () => ({ genuine: true, posture: 'open' }),
      outputGuard: { onFinal: () => ({ action: 'pass' }) },
      auditSink: (e) => audits.push(e),
    };
    const agent = createAgent({
      provider: scriptedProvider({ systems: [] }),
      model: 'test-model',
      systemPrompt: [{ text: 'base', cacheable: true }],
      conduct,
    });
    await drainRun(agent.run('hello'));
    const stages = audits.map((e) => e.stage);
    // persona fires at assembly (before query starts), then the input seams,
    // then output — assert set + relative input/output order:
    expect(stages).toContain('persona');
    expect(stages).toContain('pregate');
    expect(stages).toContain('triage');
    expect(stages).toContain('output');
    expect(stages.indexOf('pregate')).toBeLessThan(stages.indexOf('output'));
    expect(stages.indexOf('triage')).toBeLessThan(stages.indexOf('output'));
  });
});
```

- [ ] **Step 2: Run — the source-assertion test should already PASS (Tasks 9–10 landed the threading); the audit-order test verifies end-to-end**

Run: `bun test tests/conduct/seamCoverage.test.ts`
Expected: PASS. If the source assertion fails for a file, a threading was missed — fix that surface, not the test.

- [ ] **Step 3: CHANGELOG entry**

Add at the top of `CHANGELOG.md` (matching the house style):

```markdown
## sdk 0.6.0 / harness 0.6.58 — Conduct Port (1b): vendor-neutral agent-behavior seams - 2026-07-10

The SDK now carries the **Conduct Port** — the choke points for an
agent-behavior governance engine (first consumer: decorum, the Conduct &
Persona Engine). `ConductProvider` (all capabilities optional; barrel-exported)
+ five seams: persona-segment composition (cache-preserving placement),
preGate over the FINAL post-rewrite input, pre-model triage (fail-open,
refuse short-circuit), deny-first toolPolicy over the canUseTool cascade, and
the output-delivery gate in the createAgent drive loop (delta hold, final
replace/block with text-substitution that preserves tool_use adjacency,
scrub-before-persistence). Typed content-free audit events at every stage.
Gateway binds per-runtime (`RuntimeOptions.conduct`) and gates
`PostTurnRequest.instructions` (D23); channels/cron/openai-compat/missionRun
thread the same provider. Sub-agent subprocesses are a NAMED trust boundary
(a provider object doesn't cross processes; children bind at boot). WITHOUT a
bound provider, behavior is byte-identical — the null-provider invariant is
pinned by the full suite plus dedicated contract tests.
```

- [ ] **Step 4: Architecture doc**

Create `docs/02-architecture/conduct-port.md` (~40 lines): what the port is, the seam map (file:line anchors as landed), surface discipline, failure posture (SDK seams fail open; engine owns policy), the subprocess trust boundary, audit event schema, and a pointer to the spec (`~/code/me/specs/2026-07-08-sov-conduct-module-design.md`) + the decorum adapter contract (`src/conduct/decorumAdapter.ts`). Add one line to `docs/Documentation_Table_Of_Contents.md` under 02-architecture: `- [conduct-port.md](02-architecture/conduct-port.md) — the Conduct Port: agent-behavior governance seams (1b)`.

- [ ] **Step 5: Full gate + commit**

Run: `bun run typecheck && bun run lint && bun test`
Expected: everything green.

```bash
git add tests/conduct/seamCoverage.test.ts CHANGELOG.md docs/02-architecture/conduct-port.md docs/Documentation_Table_Of_Contents.md
git commit -m "test(conduct): no-bypass seam coverage + CHANGELOG + architecture doc — 1b exit bar (task 12)"
```

---

## Exit bar (1b complete when)

1. All 12 tasks committed; `bun run typecheck && bun run lint && bun test` fully green (null-provider invariant proven by the untouched existing suite).
2. The five seams live: persona (createAgent assembly), preGate (post-rewrite in query), triage (pre-model, fail-open), toolPolicy (deny-first wrapper), output gate (drive loop, every surface).
3. D23 gatings landed: post-rewrite preGate placement, perTurnInstructions gate, surface discriminator with floors-everywhere semantics, subprocess trust boundary named in code + docs.
4. All six wrapper createAgent call sites accounted for (five threaded + subprocess boundary documented).
5. decorum adapter skeleton in place with the wiring contract documented.
6. As-built delta note: report deviations from this plan back to the parent session for the spec's rolling-cadence record (per the me-repo spec §9 discipline).
