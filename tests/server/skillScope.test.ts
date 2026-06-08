// Feature B — enforce a skill's allowedTools on the user-invoked `/skill`
// path, turn-scoped.
//
// When a turn is dispatched with `kind: 'skill'` for a skill that declares
// `allowedTools`, the turns route narrows the live tool pool query() runs
// against (and the pool sub-agents inherit) to that allow-list, and denies any
// out-of-scope tool call with 'tool is outside slash-command scope'. The
// restriction lives entirely in a turn-local const — it evaporates at turn
// end. Empty/absent allowedTools (and any non-skill turn) run against the FULL
// pool, byte-identical to pre-feature behavior.
//
// Two seams are pinned:
//   1. the full POST /turns route (MockProvider.lastTools snapshot + the deny
//      reason surfaced through the tool_result SSE + the no-mutation contract);
//   2. buildSessionToolContext with the new effective-pool/canUseTool params
//      (parentToolPool === scope.tools so forked sub-agents inherit the scope;
//      the intersection drops unknown tool names; the default preserves every
//      existing caller).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolScope } from '../../src/commands/toolScope.js';
import type { CanUseTool } from '../../src/permissions/types.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildSessionToolContext } from '../../src/server/routes/turns.js';
import { buildRuntime } from '../../src/server/runtime.js';

function seedSkill(home: string, name: string, frontmatter: string, body = 'Do the thing.'): void {
  mkdirSync(join(home, '.harness', 'skills'), { recursive: true });
  writeFileSync(
    join(home, '.harness', 'skills', `${name}.md`),
    `---\n${frontmatter}\n---\n${body}\n`,
  );
}

/** Extract the stringified `output` of every `tool_result` SSE event in a
 *  drained event stream. Used by F14(a) to assert a denied tool's OUTPUT (not
 *  the always-echoed input) carries no command side effect. The output field
 *  may be a string or a content-block array, so it is normalized to a string. */
function parseSseToolResultOutputs(sseText: string): string[] {
  const outputs: string[] = [];
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let event: unknown;
    try {
      event = JSON.parse(line.slice('data: '.length));
    } catch {
      continue;
    }
    if (
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: unknown }).type === 'tool_result'
    ) {
      const output = (event as { output?: unknown }).output;
      outputs.push(typeof output === 'string' ? output : JSON.stringify(output));
    }
  }
  return outputs;
}

describe('/skill turn enforces allowedTools (Feature B — route seam)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-skill-scope-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.lastTools = undefined;
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    MockProvider.lastTools = undefined;
    MockProvider.toolUseScript = undefined;
    MockProvider.resetScriptCursor();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('narrows query() tools to the skill allowedTools (Read only)', async () => {
    seedSkill(
      tmpHome,
      'readonly',
      'name: readonly\ndescription: A read-only skill\nwhenToUse: User asks to read a file\nallowedTools: [Read]',
    );
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const fullPoolSize = runtime.toolPool.length;
      expect(fullPoolSize).toBeGreaterThan(1);
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/readonly please', kind: 'skill' }),
      });
      expect(turnRes.status).toBe(202);
      const sseText = await (await app.request(`/sessions/${sessionId}/events`)).text();

      // F14(b) — the turn actually reached the provider and ran to a terminal.
      // Asserting lastTools is DEFINED (not coalescing to []) means a turn that
      // silently no-ops the provider (e.g. skill dispatch broke) FAILS here
      // rather than masquerading as a successful narrowing to [].
      expect(sseText).toContain('turn_complete');
      expect(MockProvider.lastTools).toBeDefined();

      // FileRead carries the `Read` alias, so an allowedTools:[Read] entry
      // keeps FileRead and drops everything else.
      const names = (MockProvider.lastTools ?? []).map((t) => t.name);
      expect(names).toEqual(['FileRead']);

      // No-mutation: the shared runtime.toolPool is unchanged (guards the
      // reload contract — the pool is mutated in place on reload).
      expect(runtime.toolPool.length).toBe(fullPoolSize);
    } finally {
      await runtime.dispose();
    }
    // Explicit longer timeout: draining the SSE stream under full-suite load can
    // exceed Bun's 5s default, and a timeout here leaks MockProvider static
    // state into the next test.
  }, 15000);

  test('denies an out-of-scope Bash input with the slash-command-scope reason', async () => {
    // The skill allows Bash, but ONLY `git status` — so the Bash tool survives
    // the pool filter (it IS in scope) and the denial fires in canUseTool when
    // the input doesn't match the rule. (A tool absent from the allow-list is
    // removed from the pool entirely → 'unknown tool', a separate path.)
    seedSkill(
      tmpHome,
      'gitstatus',
      'name: gitstatus\ndescription: A git status skill\nwhenToUse: User asks for git status\nallowedTools:\n  - Bash(git status)',
    );
    // The model (mock) tries a Bash command OUTSIDE the allowed `git status`,
    // then finishes with text once it gets the denial back as a tool_result.
    // The command echoes a unique marker: if the deny were cosmetic (the tool
    // ran anyway), the marker would land in the Bash tool_result output and
    // appear in the SSE stream. F14(a) asserts it is ABSENT — i.e. the command
    // genuinely did not execute, not merely that a deny reason was reported.
    const leakMarker = 'SKILL_SCOPE_LEAK_a1b2c3';
    MockProvider.toolUseScript = [
      { kind: 'tool_use', name: 'Bash', input: { command: `echo ${leakMarker}` }, id: 'b1' },
      { kind: 'text', text: 'done' },
    ];
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/gitstatus', kind: 'skill' }),
      });
      expect(turnRes.status).toBe(202);
      const sseText = await (await app.request(`/sessions/${sessionId}/events`)).text();
      // The turn actually ran to a terminal — guards against a no-op turn
      // trivially "passing" the absence check below.
      expect(sseText).toContain('turn_complete');
      // The denial surfaces as the Bash tool_result content.
      expect(sseText).toContain('tool is outside slash-command scope');
      // F14(a) — the command's side EFFECT (its stdout) is ABSENT. The marker
      // legitimately appears on the wire as the proposed tool INPUT (the model
      // asked to run `echo <marker>`), so we cannot just scan the raw stream.
      // We inspect each Bash tool_result's OUTPUT specifically: a denied tool's
      // output is the permission-denied reason; had the deny been cosmetic and
      // the command actually run, the output would carry the marker. So the
      // marker must NOT appear in any tool_result output.
      const toolResultOutputs = parseSseToolResultOutputs(sseText);
      expect(toolResultOutputs.length).toBeGreaterThan(0);
      for (const output of toolResultOutputs) {
        expect(output).not.toContain(leakMarker);
      }
      // And the denial reason IS the output the model got back.
      expect(toolResultOutputs.some((o) => o.includes('tool is outside slash-command scope'))).toBe(
        true,
      );
    } finally {
      await runtime.dispose();
    }
    // Explicit longer timeout (SSE drain under full-suite load — see above).
  }, 15000);

  test('a malformed allowedTools entry is dropped, not crashing the turn (F2)', async () => {
    // F2 — a skill whose allowedTools carries one VALID (Read) + one genuinely
    // unparseable entry (`Bash(git log` — open paren, no close). Before F2,
    // buildToolScope mapped every entry through parsePermissionRule, so the
    // unparseable one threw "missing closing ')'", caught by the outer try →
    // the turn died with turn_error. The fix filters the skill allow-list to
    // parseable entries (fail-CLOSED: a dropped allow keeps that tool denied),
    // so the turn RUNS, Read survives, and the malformed entry is gone.
    seedSkill(
      tmpHome,
      'malformed',
      'name: malformed\ndescription: A skill with a broken rule\nwhenToUse: User asks to run the malformed skill\nallowedTools:\n  - Read\n  - Bash(git log',
    );
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/malformed', kind: 'skill' }),
      });
      expect(turnRes.status).toBe(202);
      const sseText = await (await app.request(`/sessions/${sessionId}/events`)).text();

      // The turn must COMPLETE, not error out (RED today — throws → turn_error).
      expect(sseText).toContain('turn_complete');
      expect(sseText).not.toContain('turn_error');

      // The valid Read entry was applied: the pool narrowed to FileRead only,
      // and the malformed Bash entry was dropped (so Bash is denied/absent).
      expect(MockProvider.lastTools).toBeDefined();
      const names = (MockProvider.lastTools ?? []).map((t) => t.name);
      expect(names).toEqual(['FileRead']);
    } finally {
      await runtime.dispose();
    }
    // Explicit longer timeout (SSE drain under full-suite load — see above).
  }, 15000);

  test('empty allowedTools runs against the full pool (no narrowing)', async () => {
    seedSkill(
      tmpHome,
      'unrestricted',
      'name: unrestricted\ndescription: An unrestricted skill\nwhenToUse: User asks to run the unrestricted skill',
    );
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const fullPoolSize = runtime.toolPool.length;
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/unrestricted', kind: 'skill' }),
      });
      expect(turnRes.status).toBe(202);
      const sseText = await (await app.request(`/sessions/${sessionId}/events`)).text();

      // F14(b) — the turn ran to a terminal and the provider was actually
      // invoked; a no-op turn would leave lastTools undefined and fail here
      // rather than coalescing to [] and quietly matching nothing.
      expect(sseText).toContain('turn_complete');
      expect(MockProvider.lastTools).toBeDefined();
      expect((MockProvider.lastTools ?? []).length).toBe(fullPoolSize);
    } finally {
      await runtime.dispose();
    }
    // Explicit longer timeout (SSE drain under full-suite load — see above).
  }, 15000);

  test('a plain (non-skill) turn runs against the full pool', async () => {
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      preflight: false,
    });
    try {
      const fullPoolSize = runtime.toolPool.length;
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'just a normal message' }),
      });
      expect(turnRes.status).toBe(202);
      const sseText = await (await app.request(`/sessions/${sessionId}/events`)).text();

      // F14(b) — the turn ran to a terminal and the provider was actually
      // invoked; a no-op turn would leave lastTools undefined and fail here
      // rather than coalescing to [] and quietly matching nothing.
      expect(sseText).toContain('turn_complete');
      expect(MockProvider.lastTools).toBeDefined();
      expect((MockProvider.lastTools ?? []).length).toBe(fullPoolSize);
    } finally {
      await runtime.dispose();
    }
    // Explicit longer timeout (SSE drain under full-suite load — see above).
  }, 15000);
});

describe('buildSessionToolContext effective pool (Feature B — context seam)', () => {
  let tmpHome: string;
  let tmpCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-skill-scope-ctx-home-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'sov-skill-scope-ctx-cwd-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  const allowAll: CanUseTool = async () => ({ behavior: 'allow' });

  test('defaults parentToolPool/canUseTool to the runtime pool (back-compat)', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    try {
      // No effective-pool param → the helper must behave exactly as before:
      // parentToolPool IS the shared runtime pool, canUseTool IS the one passed.
      const ctx = buildSessionToolContext(runtime, 'sess', allowAll);
      expect(ctx.parentToolPool).toBe(runtime.toolPool);
      expect(ctx.canUseTool).toBe(allowAll);
    } finally {
      await runtime.dispose();
    }
  });

  test('forked sub-agents inherit the scoped pool (parentToolPool === scope.tools)', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    try {
      const scope = buildToolScope({
        allowedTools: ['Read'],
        tools: runtime.toolPool,
        canUseTool: allowAll,
      });
      const ctx = buildSessionToolContext(runtime, 'sess', scope.canUseTool, {
        effectivePool: scope.tools,
      });
      // The child inherits the SCOPED pool, not the full runtime pool.
      expect(ctx.parentToolPool).toBe(scope.tools);
      expect(ctx.canUseTool).toBe(scope.canUseTool);
      expect((ctx.parentToolPool ?? []).map((t) => t.name)).toEqual(['FileRead']);
      // The shared runtime pool is untouched.
      expect(runtime.toolPool.length).toBeGreaterThan(1);
    } finally {
      await runtime.dispose();
    }
  });

  test('intersection drops unknown tool names', async () => {
    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'mock',
      preflight: false,
    });
    try {
      const scope = buildToolScope({
        allowedTools: ['Read', 'NonexistentTool'],
        tools: runtime.toolPool,
        canUseTool: allowAll,
      });
      // NonexistentTool matches nothing → only FileRead survives.
      expect(scope.tools.map((t) => t.name)).toEqual(['FileRead']);
    } finally {
      await runtime.dispose();
    }
  });
});
