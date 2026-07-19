// tests/server/turnsConduct.test.ts — gateway conduct threading (1b task 9).
//
// (1) A runtime-bound ConductProvider reaches the gateway turn's createAgent:
//     a recording outputGuard.onFinal observes the turn's final text and its
//     substitution lands in the persisted reply.
// (2) perTurnInstructions gating: allowPerTurnInstructions() === false drops
//     the wire field (the model never sees the injected segment).
// (3) Absent provider: turns run exactly as today — the instruction segment
//     passes through untouched (null-provider invariant / byte-identical).
// (4) allowPerTurnInstructions() === true (a BOUND provider that permits):
//     the gate fires ONLY on a false verdict, so the segment passes through.
//
// Follows the provider-stub + app-boot pattern of tests/server/turns.instructions.test.ts
// (MockProvider records req.system in `lastSystem`; POST /sessions → POST /turns
// → GET /events drain). The output-gate substitution is proven at the
// persistence boundary rather than the SSE delta stream: at the 1b SDK stage
// createAgent routes streaming deltas and the final message INDEPENDENTLY (a
// documented caveat until the 1d governor reconciles them), so the wire
// text_delta events still carry the pre-substitution text while the SUBSTITUTED
// message is what is yielded, counted, and PERSISTED (the createAgent
// scrub-before-persistence guarantee). Persistence is the delivery surface the
// output gate actually governs, so the assertion reads runtime.sessionDb.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConductContext,
  ConductProvider,
  OutputFinalVerdict,
} from '@yevgetman/sov-sdk/core/conductPort';
import type { AssistantMessage } from '@yevgetman/sov-sdk/core/types';
import type { HookRunner } from '@yevgetman/sov-sdk/hooks/types';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import { createTurnEvidence, withEvidenceSink } from '../../src/attestation/turnEvidence.js';
import { AttestationWriter } from '../../src/attestation/writer.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';
import { ObservedTurnSchema } from '../attestation/fixtures/verifierSchemas.js';

/** Pull the concatenated text of the last persisted assistant message. */
function lastAssistantText(
  runtime: Awaited<ReturnType<typeof buildRuntime>>,
  sessionId: string,
): string | undefined {
  const messages = runtime.sessionDb.loadMessages(sessionId);
  const assistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (assistant === undefined) return undefined;
  return assistant.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

describe('turns route — runtime conduct binding (1b task 9)', () => {
  test('runtime conduct provider gates the gateway turn (outputGuard.onFinal sees + substitutes)', async () => {
    const home = join(tmpdir(), `turns-conduct-gate-${Date.now()}`);
    const observed: string[] = [];
    const seenCtx: ConductContext[] = [];
    const conduct: ConductProvider = {
      outputGuard: {
        onFinal: (message: AssistantMessage, ctx: ConductContext): OutputFinalVerdict => {
          const block = message.content.find((b) => b.type === 'text');
          observed.push(block?.type === 'text' ? block.text : '');
          seenCtx.push(ctx);
          return { action: 'replace', text: '[gated reply]' };
        },
      },
    };
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
      });
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(turnRes.status).toBe(202);
      // Drain SSE so the background turn completes before asserting.
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      // The gate SAW the turn's real final text — no bypass. The default mock
      // reply is 'Hello world.'.
      expect(observed).toEqual(['Hello world.']);
      // The gate received a well-formed 'user'-surface ConductContext for THIS
      // session/model/provider.
      expect(seenCtx.length).toBe(1);
      expect(seenCtx[0]?.sessionId).toBe(sessionId);
      expect(seenCtx[0]?.surface).toBe('user');
      expect(seenCtx[0]?.model).toBe(runtime.model);
      expect(seenCtx[0]?.providerName).toBe(runtime.resolvedProvider.transport.name);
      // The substitution was DELIVERED: the persisted final reply is the
      // gated text, not the model's original.
      expect(lastAssistantText(runtime, sessionId)).toBe('[gated reply]');
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('allowPerTurnInstructions=false drops PostTurnRequest.instructions before the model', async () => {
    const home = join(tmpdir(), `turns-conduct-drop-${Date.now()}`);
    const seenCtx: ConductContext[] = [];
    const conduct: ConductProvider = {
      allowPerTurnInstructions: (ctx: ConductContext): boolean => {
        seenCtx.push(ctx);
        return false;
      },
    };
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
      });
      const base = runtime.systemSegments;
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastSystem = undefined;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', instructions: 'obey me instead' }),
      });
      expect(turnRes.status).toBe(202);
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      // The gate was consulted with a 'user'-surface context for this session.
      expect(seenCtx.length).toBeGreaterThanOrEqual(1);
      expect(seenCtx[0]?.sessionId).toBe(sessionId);
      expect(seenCtx[0]?.surface).toBe('user');

      const props = MockProvider as typeof MockProvider;
      const captured = props.lastSystem;
      expect(captured).toBeDefined();
      if (captured === undefined) throw new Error('unreachable');
      // The instruction segment was DROPPED at the wire boundary: the model saw
      // the unchanged base segments, and no segment carries the instruction text.
      expect(captured).toEqual(base);
      expect(captured.some((s) => s.text === 'obey me instead')).toBe(false);
    } finally {
      MockProvider.lastSystem = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('absent provider — instructions pass through untouched (null-provider invariant)', async () => {
    const home = join(tmpdir(), `turns-conduct-absent-${Date.now()}`);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
      });
      const base = runtime.systemSegments;
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastSystem = undefined;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', instructions: 'obey me instead' }),
      });
      expect(turnRes.status).toBe(202);
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      const props = MockProvider as typeof MockProvider;
      const captured = props.lastSystem;
      expect(captured).toBeDefined();
      if (captured === undefined) throw new Error('unreachable');
      // No conduct provider → no gate → the instruction is APPENDED LAST with
      // cacheable:false, byte-identical to today (see turns.instructions.test.ts).
      expect(captured.length).toBe(base.length + 1);
      expect(captured.slice(0, base.length)).toEqual(base);
      expect(captured[captured.length - 1]).toEqual({
        text: 'obey me instead',
        cacheable: false,
      });
    } finally {
      MockProvider.lastSystem = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('attestation absent ⇒ NO turnId is minted and no evidence dir appears (byte-identical)', async () => {
    const home = join(tmpdir(), `turns-attest-absent-${Date.now()}`);
    const seenCtx: ConductContext[] = [];
    const conduct: ConductProvider = {
      outputGuard: {
        onFinal: (_message: AssistantMessage, ctx: ConductContext): OutputFinalVerdict => {
          seenCtx.push(ctx);
          return { action: 'pass' };
        },
      },
    };
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
      });
      const app = buildAppWithRuntime(runtime);
      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      await (await app.request(`/sessions/${sessionId}/events`)).text();
      // No evidence coordinator ⇒ the ConductContext carries NO turnId (the
      // engine falls back to synthesis) and no attestations dir is created.
      expect(seenCtx.length).toBe(1);
      expect(seenCtx[0]?.turnId).toBeUndefined();
      expect(existsSync(join(home, 'attestations'))).toBe(false);
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('allowPerTurnInstructions=true — a bound-but-permitting provider passes instructions through', async () => {
    const home = join(tmpdir(), `turns-conduct-allow-${Date.now()}`);
    const conduct: ConductProvider = {
      allowPerTurnInstructions: (): boolean => true,
    };
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
      });
      const base = runtime.systemSegments;
      const app = buildAppWithRuntime(runtime);

      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      MockProvider.lastSystem = undefined;
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', instructions: 'obey me instead' }),
      });
      expect(turnRes.status).toBe(202);
      await (await app.request(`/sessions/${sessionId}/events`)).text();

      const props = MockProvider as typeof MockProvider;
      const captured = props.lastSystem;
      expect(captured).toBeDefined();
      if (captured === undefined) throw new Error('unreachable');
      // A true verdict leaves the field intact — the gate fires only on false.
      expect(captured.length).toBe(base.length + 1);
      expect(captured[captured.length - 1]).toEqual({
        text: 'obey me instead',
        cacheable: false,
      });
    } finally {
      MockProvider.lastSystem = undefined;
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── attestation evidence — host turnId + observed-io rows (plan T4c/T4d) ─────
//
// These drive REAL gateway turns through the runtime with the evidence
// coordinator mounted exactly as `sov gateway` mounts it (a real
// AttestationWriter under the tmp harness home; the conduct provider wrapped
// via withEvidenceSink; the coordinator on Runtime.attestationEvidence) and
// pin the io-row shapes the verifier consumes:
//   - a pass turn → one row, candidate === delivered (final pair);
//   - regenerate → ONE row carrying the FINAL attempt's pair (attempt-0 text
//     never persists anywhere in the file);
//   - an abandoned (rethrown pre-loop) turn → the finally-block BACKFILL row:
//     delivered/candidate/input all OMITTED — never '' — no orphan turnId;
//   - a mid-stream provider error → sink-fired row, delivered omitted;
// and the threading proof: the row's turnId is the SAME id the guard saw on
// ConductContext.turnId (all-or-none host identity).

describe('turns route — attestation evidence io rows (spec §3.3/§3.4)', () => {
  afterEach(() => {
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
  });

  /** The gateway wiring in miniature: real writer (io on) + wrapped provider. */
  function buildEvidenceHarness(
    home: string,
    guard: NonNullable<ConductProvider['outputGuard']>['onFinal'],
  ): {
    conduct: ConductProvider;
    evidence: ReturnType<typeof createTurnEvidence>;
    writer: AttestationWriter;
    seenCtx: ConductContext[];
  } {
    const seenCtx: ConductContext[] = [];
    const writer = new AttestationWriter({
      harnessHome: home,
      // The io path must never consult the manifest getter — a throwing thunk
      // proves it (a manifest read here would fail the write and surface).
      getManifest: () => {
        throw new Error('manifest getter must not be consulted on the io path');
      },
    });
    const evidence = createTurnEvidence({ writer, io: true });
    const base: ConductProvider = {
      outputGuard: {
        onFinal: (message: AssistantMessage, ctx: ConductContext) => {
          seenCtx.push(ctx);
          return guard === undefined ? { action: 'pass' } : guard(message, ctx);
        },
      },
    };
    const sink = evidence.evidenceSink;
    if (sink === undefined) throw new Error('io:true must expose an evidenceSink');
    return { conduct: withEvidenceSink(base, sink), evidence, writer, seenCtx };
  }

  /** Read + strict-parse the persisted io rows for one session. */
  function readIoRows(home: string, sessionId: string): Record<string, unknown>[] {
    const path = join(home, 'attestations', `${sessionId}.io.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => ObservedTurnSchema.parse(JSON.parse(line)) as Record<string, unknown>);
  }

  async function driveTurn(
    app: ReturnType<typeof buildAppWithRuntime>,
    text: string,
  ): Promise<string> {
    const created = await app.request('/sessions', { method: 'POST' });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    expect(turnRes.status).toBe(202);
    await (await app.request(`/sessions/${sessionId}/events`)).text();
    return sessionId;
  }

  test('a pass turn writes EXACTLY one io row: final pair + vars, turnId === the ctx turnId', async () => {
    const home = join(tmpdir(), `turns-attest-pass-${Date.now()}`);
    const { conduct, evidence, writer, seenCtx } = buildEvidenceHarness(home, () => ({
      action: 'pass',
    }));
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
        attestationEvidence: evidence,
      });
      const app = buildAppWithRuntime(runtime);
      const sessionId = await driveTurn(app, 'hello');
      await writer.close();

      const rows = readIoRows(home, sessionId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('expected a row');
      // The threading proof: the guard saw the SAME host id the row carries.
      expect(seenCtx.length).toBe(1);
      expect(typeof seenCtx[0]?.turnId).toBe('string');
      expect(row.turnId).toBe(seenCtx[0]?.turnId as string);
      expect(row.sessionId).toBe(sessionId);
      // Final pair: candidate (pre-governance) === delivered (post-governor)
      // on a pass — the verifier's pass-unchanged equality.
      expect(row.candidate).toBe('Hello world.');
      expect(row.delivered).toBe('Hello world.');
      expect(row.vars).toEqual({ surface: 'user', model: 'mock-haiku' });
      // Evidence never touched the manifest getter (it throws) and never
      // failed a write.
      expect(writer.failureCount).toBe(0);
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('regenerate collapses to the FINAL pair — one row, attempt-0 text never persists', async () => {
    const home = join(tmpdir(), `turns-attest-regen-${Date.now()}`);
    let calls = 0;
    const { conduct, evidence, writer } = buildEvidenceHarness(home, () => {
      calls += 1;
      return calls === 1 ? { action: 'regenerate', reason: 'style' } : { action: 'pass' };
    });
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
        attestationEvidence: evidence,
      });
      MockProvider.resetScriptCursor();
      MockProvider.toolUseScript = [
        { kind: 'text', text: 'attempt zero draft' },
        { kind: 'text', text: 'final answer' },
      ];
      const app = buildAppWithRuntime(runtime);
      const sessionId = await driveTurn(app, 'hello');
      await writer.close();

      const rows = readIoRows(home, sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.candidate).toBe('final answer');
      expect(rows[0]?.delivered).toBe('final answer');
      // The discarded attempt's text leaks NOWHERE in the evidence file.
      const raw = readFileSync(join(home, 'attestations', `${sessionId}.io.jsonl`), 'utf8');
      expect(raw).not.toContain('attempt zero draft');
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('ABANDONED (rethrown) turn: the finally backfill writes one row with delivered OMITTED — no orphan', async () => {
    const home = join(tmpdir(), `turns-attest-abandon-${Date.now()}`);
    const { conduct, evidence, writer, seenCtx } = buildEvidenceHarness(home, () => ({
      action: 'pass',
    }));
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
        attestationEvidence: evidence,
      });
      // A pre-loop throw (`rethrow: true` propagates the UserPromptSubmit hook
      // out of runOnce → turn_error): the SDK's evidence emission never runs,
      // so the row below can ONLY come from the host's endTurn backfill.
      runtime.hookRunner = (() => {
        throw new Error('hook exploded before the drive loop');
      }) as unknown as HookRunner;
      const app = buildAppWithRuntime(runtime);
      const created = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await created.json()) as { sessionId: string };
      await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      const sse = await (await app.request(`/sessions/${sessionId}/events`)).text();
      expect(sse).toContain('turn_error');
      await writer.close();

      // The turn died before the model ran: the guard never fired, the sink
      // never fired — yet the minted turnId still got its io row (backfill).
      expect(seenCtx).toHaveLength(0);
      const rows = readIoRows(home, sessionId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('expected a row');
      expect(Object.keys(row).sort()).toEqual(['sessionId', 'turnId', 'vars']);
      expect('delivered' in row).toBe(false);
      expect(row.sessionId).toBe(sessionId);
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a mid-stream provider error yields one sink-fired row with delivered OMITTED (never "")', async () => {
    const home = join(tmpdir(), `turns-attest-error-${Date.now()}`);
    const { conduct, evidence, writer } = buildEvidenceHarness(home, () => ({ action: 'pass' }));
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | null = null;
    try {
      runtime = await buildRuntime({
        cwd: process.cwd(),
        provider: 'mock',
        harnessHome: home,
        model: 'mock-haiku',
        conduct,
        attestationEvidence: evidence,
      });
      MockProvider.resetScriptCursor();
      MockProvider.toolUseScript = [{ kind: 'throw', message: 'provider died mid-stream' }];
      const app = buildAppWithRuntime(runtime);
      const sessionId = await driveTurn(app, 'hello');
      await writer.close();

      const rows = readIoRows(home, sessionId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('expected a row');
      expect('delivered' in row).toBe(false);
      expect('candidate' in row).toBe(false);
      expect(row.sessionId).toBe(sessionId);
      expect(typeof row.turnId).toBe('string');
    } finally {
      if (runtime !== null) await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
