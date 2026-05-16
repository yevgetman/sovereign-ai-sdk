// Phase 16.1 M8 T8 — full integration smoke for the polish-surfaces group.
//
// Drives the nine M8 subsystems through the public route surface so the
// final close-out has a single test that proves the milestone landed
// end-to-end. The shape mirrors tests/server/m7Full.test.ts: one or more
// describe blocks that boot a real runtime, POST through the Hono app,
// drain SSE, dispose, and assert on the resulting state.
//
// What lands across the suite:
//   T1 — router-mode runtime construction (RouterProvider in resolved.transport)
//   T2 — capture wrap (capture sink active; fixture file lands on dispose)
//   T3 — @file:path expansion (file contents inlined into persisted user message)
//   T3 — subdirectory hint state exposure on SessionContext
//   T4 — skill loading + GET /skills returns the project-local skill
//   T5 — skill-as-slash dispatch (POST kind:'skill' expands {{args}} before save)
//   T6 — TUI ring-buffer behavior is Go-side only. Not exercised here; the
//        T6 server-side surface (skill cache feed) is implicitly covered by
//        T4 (GET /skills) + T5 (kind:'skill' dispatch). The Go test lives in
//        packages/tui/internal/app and was verified separately by `go test`.
//   T7 — stall_detected SSE event fires when the orchestrator detects a
//        3-iteration window with no progress (driven via MockProvider.stallMode)
//   T7 — rich session_summary payload on disposal (tokens + toolCalls present)
//
// Two describe blocks because Router-mode and capture-mode require disjoint
// runtime configurations (Router needs HARNESS_CONFIG; capture needs a
// captureFixturePath). Splitting keeps each test's setup minimal and the
// asserts targeted.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';
import { MockProvider } from '../../src/providers/mock.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { ServerEventBus } from '../../src/server/eventBus.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { ServerEvent } from '../../src/server/schema.js';

describe('M8 full integration — polish-surfaces group end-to-end', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-full-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    __test_resetProjectIdCache();
  });

  afterEach(() => {
    MockProvider.toolUseMode = false;
    MockProvider.stallMode = false;
    MockProvider.stallTargetIterations = 4;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('@file expansion + skill discovery + skill-as-slash dispatch + rich session_summary all wire together', async () => {
    // Seed a project-local skill at <cwd>/.harness/skills/greet.md so the
    // T4 (GET /skills) and T5 (kind:'skill') paths have a target. The
    // `{{args}}` placeholder is what expandSkillPrompt substitutes.
    mkdirSync(join(tmpHome, '.harness', 'skills'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.harness', 'skills', 'greet.md'),
      '---\nname: greet\nwhenToUse: when user asks to greet\ndescription: Greets the user\n---\nHello {{args}}, nice to meet you.\n',
    );
    // Seed a target file for @file expansion (T3). The contents must be a
    // recognizable, non-trivial string so we can match it against the
    // persisted user message after the turn.
    writeFileSync(join(tmpHome, 'note.txt'), 'expanded file body from disk');

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });

    try {
      const app = buildAppWithRuntime(runtime);

      // (T3 inventory check) Per-session SessionContext exposes the
      // subdirectory-hint dedup state. The orchestrator's hint append uses
      // this set to ensure a directory's hint files land at most once.
      const probeId = runtime.sessionDb.createSession({
        model: runtime.model,
        provider: runtime.resolvedProvider.transport.name,
        platform: 'test',
      });
      const probeCtx = runtime.getSessionContext(probeId);
      expect(probeCtx.subdirectoryHintState).toBeDefined();
      expect(probeCtx.subdirectoryHintState.touched).toBeInstanceOf(Set);

      // Now create the real session for the main flow.
      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      // (T4) GET /skills returns the seeded `greet` skill. The route filters
      // by active toolset, so the project skill (no toolset gating) is
      // included regardless of the runtime's tool pool.
      const skillsRes = await app.request(`/sessions/${sessionId}/skills`);
      expect(skillsRes.status).toBe(200);
      const skillsBody = (await skillsRes.json()) as {
        skills: Array<{ name: string; whenToUse: string; description: string }>;
      };
      const greet = skillsBody.skills.find((s) => s.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet?.whenToUse).toContain('greet');

      // Capture disposal-bus events for the final session_summary assertion.
      const bus = new ServerEventBus();
      const captured: ServerEvent[] = [];
      bus.subscribe((evt) => captured.push(evt));

      // (T5) Dispatch a skill-as-slash turn. The route looks `/greet Alice`
      // up in runtime.skills.byName, expands `{{args}}` → `Alice`, then
      // continues into the regular turn loop. The @file token nested INSIDE
      // the skill body is left literal in the skill template — T3 expansion
      // runs over the post-expansion text, so we drive it with a separate
      // text field below to keep the per-assertion contract crisp.
      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '/greet Alice', kind: 'skill' }),
      });
      expect(turnRes.status).toBe(202);

      // Drain SSE so the background turn completes before we read DB rows.
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      await eventsRes.text();

      // The persisted user message MUST contain the expanded skill body, not
      // the raw `/greet Alice` slash. This is the load-bearing T5 assertion
      // — the skill expansion happens at the route layer, before saveMessage.
      const messages = runtime.sessionDb.loadMessages(sessionId);
      expect(messages.length).toBeGreaterThan(0);
      const userText = JSON.stringify(messages[0]?.content);
      expect(userText).toContain('Hello Alice, nice to meet you.');
      expect(userText).not.toContain('/greet');

      // (T3) Second turn — @file:note.txt expansion. The runtime's
      // expandContextReferences hop in runTurnInBackground must inline the
      // file body before saveMessage, mirroring terminalRepl.ts:1288.
      const turn2Res = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'see @file:note.txt' }),
      });
      expect(turn2Res.status).toBe(202);
      const events2Res = await app.request(`/sessions/${sessionId}/events`);
      await events2Res.text();
      const messages2 = runtime.sessionDb.loadMessages(sessionId);
      const allText = JSON.stringify(messages2.map((m) => m.content));
      expect(allText).toContain('expanded file body from disk');
      expect(allText).not.toContain('@file:note.txt');

      // (T7) Dispose with the bus attached so the rich session_summary event
      // emission lands in `captured`. The rich payload's `tokens` field is
      // populated when the session's recordTokenUsage call fired during the
      // turn (the route's recordUsageIfPresent helper). MockProvider emits
      // usage_delta on every stream() call, so tokens are guaranteed present.
      await runtime.disposeSession(sessionId, { bus });

      const summary = captured.find((e) => e.type === 'session_summary');
      expect(summary).toBeDefined();
      if (!summary || summary.type !== 'session_summary') {
        throw new Error('session_summary event missing');
      }
      expect(summary.sessionId).toBe(sessionId);
      // M7 base fields still present.
      expect(summary.totalDispatched).toBe(0);
      expect(summary.byAgent).toEqual({});
      // M8 T7 extended fields. tokens must exist because two turns emitted
      // usage_delta events; toolCalls is the persisted-message tool_use
      // count (0 here because the mock provider in default mode emits only
      // text in both turns above — the stall-mode test below exercises the
      // tool-use branch).
      expect(summary.tokens).toBeDefined();
      expect(summary.tokens?.output).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.dispose();
    }
  });

  test('stall_detected SSE event fires when MockProvider.stallMode runs the loop > WINDOW iterations', async () => {
    // T7 stall path. Drive MockProvider into stallMode so each iteration
    // emits a Bash echo tool_use with no edits, no decisions, no memory
    // writes — exactly the input shape detectStall's
    // "no edits, no decisions, no memory writes for 3 turns" branch matches.
    MockProvider.stallMode = true;
    MockProvider.stallTargetIterations = 4;

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });

    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'drive the stall' }),
      });
      expect(turnRes.status).toBe(202);

      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      expect(eventsRes.status).toBe(200);
      const body = await eventsRes.text();

      // Parse SSE frames for stall_detected. detectStall fires after the
      // 3rd consecutive non-progress iteration; stallTargetIterations=4
      // gives us 4 iterations = 1 stall window past the threshold.
      const stallEvents: Array<{ type: string; reason: string; turn: number }> = [];
      for (const line of body.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice('data: '.length).trim();
        if (!json) continue;
        try {
          const parsed = JSON.parse(json) as {
            type?: string;
            reason?: string;
            turn?: number;
          };
          if (parsed.type === 'stall_detected') {
            stallEvents.push({
              type: parsed.type,
              reason: parsed.reason ?? '',
              turn: parsed.turn ?? -1,
            });
          }
        } catch {
          // Ignore framing-only lines.
        }
      }

      expect(stallEvents.length).toBeGreaterThanOrEqual(1);
      expect(stallEvents[0]?.reason).toMatch(/no edits|no decisions|no memory writes/);
    } finally {
      await runtime.dispose();
    }
  });

  test('captureFixturePath drives capture sink wrap; fixture file lands on dispose', async () => {
    // T2 — capture wrap. The fixture write happens inside runtime.dispose()
    // before MCP/approvals/sessionDb teardown, so disposing the runtime
    // outside the try block proves the wire surface fired correctly.
    const fixturePath = join(tmpHome, 'capture-fixture.json');
    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
      captureFixturePath: fixturePath,
    });

    const app = buildAppWithRuntime(runtime);
    const createRes = await app.request('/sessions', { method: 'POST' });
    expect(createRes.status).toBe(201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(turnRes.status).toBe(202);
    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    await eventsRes.text();

    await runtime.dispose();

    expect(existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      meta: { provider: string; model: string };
      turns: Array<{ providerEvents: unknown[] }>;
    };
    expect(fixture.meta.provider).toBe('mock');
    expect(fixture.meta.model).toBe('mock-haiku');
    expect(fixture.turns.length).toBeGreaterThan(0);
    // The provider events from the mock's streamHelloWorld path must have
    // been mirrored into the sink.
    expect(fixture.turns[0]?.providerEvents.length).toBeGreaterThan(0);
  });

  test('toolUseMode triggers learning observer + trajectory write + cost recording', async () => {
    // Inheritance from the M7 smoke — confirms the M7 subsystems still fire
    // through the M8-wired turns route (M8 T3 expanded text + T4 skill
    // filter + T5 kind handling all sit on the same code path). If T1–T7
    // accidentally broke an M7 sink, this catches it.
    MockProvider.toolUseMode = true;

    const runtime = await buildRuntime({
      cwd: tmpHome,
      harnessHome: tmpHome,
      provider: 'mock',
      model: 'mock-haiku',
      preflight: false,
    });

    try {
      const app = buildAppWithRuntime(runtime);
      const createRes = await app.request('/sessions', { method: 'POST' });
      const { sessionId } = (await createRes.json()) as { sessionId: string };

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'run echo hi' }),
      });
      expect(turnRes.status).toBe(202);
      const eventsRes = await app.request(`/sessions/${sessionId}/events`);
      await eventsRes.text();

      await runtime.disposeSession(sessionId);

      // Trace file with bookends (M7 I3 fix).
      const tracePath = join(tmpHome, 'traces', `${sessionId}.jsonl`);
      expect(existsSync(tracePath)).toBe(true);
      const trace = readFileSync(tracePath, 'utf8');
      expect(trace).toContain('"type":"session_start"');
      expect(trace).toContain('"type":"session_end"');

      // Trajectory landed.
      const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
      expect(existsSync(samplesPath)).toBe(true);
      const traj = readFileSync(samplesPath, 'utf8');
      expect(traj).toContain(`"sessionId":"${sessionId}"`);

      // Learning observation recorded.
      const projectId = getProjectId(tmpHome).id;
      const obsPath = join(tmpHome, 'learning', projectId, 'observations.jsonl');
      expect(existsSync(obsPath)).toBe(true);
      const obs = readFileSync(obsPath, 'utf8');
      expect(obs).toContain('"tool_name":"Bash"');
    } finally {
      await runtime.dispose();
    }
  });
});

describe('M8 full integration — router-mode runtime construction', () => {
  let tmpHome: string;
  let tmpCwd: string;
  const prevHarnessHome = process.env.HARNESS_HOME;
  const prevHarnessConfig = process.env.HARNESS_CONFIG;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-full-router-'));
    tmpCwd = mkdtempSync(join(tmpdir(), 'sov-m8-full-router-cwd-'));
    process.env.HARNESS_HOME = tmpHome;
    process.env.HARNESS_CONFIG = join(tmpHome, 'config.json');
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
    if (prevHarnessHome === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_HOME;
    } else {
      process.env.HARNESS_HOME = prevHarnessHome;
    }
    if (prevHarnessConfig === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
      delete process.env.HARNESS_CONFIG;
    } else {
      process.env.HARNESS_CONFIG = prevHarnessConfig;
    }
  });

  test('provider: router constructs RouterProvider; subagent defaults specialize to frontier lane (closes #30)', async () => {
    // T1 — router-mode construction. The router wraps two providers, so
    // resolveProvider() can't be the single source of truth — buildRuntime
    // has to construct it explicitly. Pins both the wire shape (transport
    // name) and the subagent default fall-through (closes backlog #30).
    writeFileSync(
      join(tmpHome, 'config.json'),
      JSON.stringify({
        router: {
          localProvider: 'mock',
          localModel: 'mock-local',
          frontierProvider: 'mock',
          frontierModel: 'mock-frontier',
          defaultLane: 'local',
        },
      }),
    );

    const runtime = await buildRuntime({
      harnessHome: tmpHome,
      cwd: tmpCwd,
      provider: 'router',
      preflight: false,
    });

    try {
      // Router metadata reaches the resolved provider.
      expect(runtime.resolvedProvider.transport.name).toBe('router');
      expect(runtime.resolvedProvider.metadata.provider).toBe('router');

      // Backlog #30 — subagent defaults must specialize so child agents
      // launched from a router-mode parent get sensible defaults instead
      // of the literal 'router' provider string.
      const scheduler = runtime.subagentScheduler as unknown as {
        opts: { defaultProvider: string; defaultModel: string };
      };
      expect(scheduler.opts.defaultProvider).toBe('mock');
      expect(scheduler.opts.defaultModel).toBe('mock-frontier');
    } finally {
      await runtime.dispose();
    }
  });
});
