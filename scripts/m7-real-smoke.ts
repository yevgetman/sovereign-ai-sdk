#!/usr/bin/env bun
// M7 autonomous smoke test against REAL Anthropic (Haiku 4.5).
//
// Drives one real turn through the production server runtime and asserts
// that every per-session subsystem M7 wired into SessionContext lands its
// expected output, against the real provider the harness will use in prod.
//
// Mirrors the M6 pattern (/tmp/m6-real-smoke-*.ts) — wire-level autonomous
// smoke that bypasses the Bubble Tea TUI's visual surface but exercises the
// real backend.
//
// Cost: ~$0.01-0.03 per run on Haiku.
//
// Run: bun scripts/m7-real-smoke.ts

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bridge: harness's `resolveProvider` looks at userSettings.providers.anthropic.apiKey
// (per the user's ~/.harness/config.json) OR the ANTHROPIC_API_KEY env var.
// We point HARNESS_HOME at a tmpdir so the smoke doesn't pollute real state,
// then export the real API key from the user's config to the env var path.
const userConfig = JSON.parse(
  readFileSync(`${process.env.HOME}/.harness/config.json`, 'utf8'),
) as {
  providers?: { anthropic?: { apiKey?: string } };
};
const apiKey = userConfig.providers?.anthropic?.apiKey;
if (!apiKey) {
  console.error('[smoke] FAIL: no Anthropic API key in ~/.harness/config.json');
  process.exit(1);
}
process.env.ANTHROPIC_API_KEY = apiKey;

// Dynamic imports so the env var is set before module load.
const { __test_resetProjectIdCache, getProjectId } = await import(
  '../src/learning/project.ts'
);
const { buildAppWithRuntime } = await import('../src/server/app.ts');
const { ServerEventBus } = await import('../src/server/eventBus.ts');
const { buildRuntime } = await import('../src/server/runtime.ts');
type ServerEvent = import('../src/server/schema.ts').ServerEvent;

const tmpHome = mkdtempSync(join(tmpdir(), 'sov-m7-real-'));
console.log(`[smoke] tmpHome: ${tmpHome}`);
console.log(`[smoke] HEAD: ${process.env.SOV_HEAD ?? '(see git log)'}`);
__test_resetProjectIdCache();

const startMs = Date.now();
let preserveTmp = false;
let failed = false;

const ok = (label: string, condition: boolean, detail?: string): void => {
  const mark = condition ? '✓' : '✗';
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failed = true;
};

try {
  console.log(
    '\n[smoke] building runtime: provider=anthropic model=claude-haiku-4-5-20251001',
  );
  const runtime = await buildRuntime({
    cwd: tmpHome,
    harnessHome: tmpHome,
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    preflight: false,
  });
  console.log(
    `[smoke] runtime ready. provider=${runtime.resolvedProvider.transport.name} model=${runtime.model}`,
  );

  try {
    const app = buildAppWithRuntime(runtime);
    const disposalBus = new ServerEventBus();
    const captured: ServerEvent[] = [];
    disposalBus.subscribe((evt) => captured.push(evt));

    // (1) Create the session via the public route.
    const createRes = await app.request('/sessions', { method: 'POST' });
    if (createRes.status !== 201) {
      throw new Error(`session create failed: ${createRes.status}`);
    }
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    console.log(`[smoke] session created: ${sessionId}`);

    // (2) Touch context — lazy-build subsystems before turn fires.
    const ctx = runtime.getSessionContext(sessionId);
    console.log(`[smoke] traceWriter=${!!ctx.traceWriter} learning=${!!ctx.learningObserver} review=${!!ctx.reviewManager}`);

    // (3) Drive ONE real turn that requests a Bash tool call.
    console.log('\n[smoke] firing real turn against Anthropic...');
    const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Use the Bash tool to run exactly: echo "hello from m7 smoke". Then say "done" in one word.',
      }),
    });
    if (turnRes.status !== 202) {
      throw new Error(`turn create failed: ${turnRes.status}`);
    }

    // (4) Drain SSE until turn_complete (or turn_error).
    const eventsRes = await app.request(`/sessions/${sessionId}/events`);
    if (eventsRes.status !== 200) {
      throw new Error(`events stream failed: ${eventsRes.status}`);
    }
    const sseBody = await eventsRes.text();
    const sawTurnComplete = sseBody.includes('"type":"turn_complete"');
    const sawTurnError = sseBody.includes('"type":"turn_error"');
    console.log(
      `[smoke] turn drained. turn_complete=${sawTurnComplete} turn_error=${sawTurnError}`,
    );

    // (5) Dispose with bus attached so session_summary lands.
    await runtime.disposeSession(sessionId, { bus: disposalBus });
    console.log('[smoke] session disposed.\n');

    // --------- Verification ---------
    console.log('[smoke] verification:');

    // T3 — Trace file with bookends
    const tracePath = join(tmpHome, 'traces', `${sessionId}.jsonl`);
    ok('trace file exists', existsSync(tracePath), tracePath);
    if (existsSync(tracePath)) {
      const trace = readFileSync(tracePath, 'utf8');
      ok('trace: session_start', trace.includes('"type":"session_start"'));
      ok('trace: turn_start', trace.includes('"type":"turn_start"'));
      ok('trace: provider_request', trace.includes('"type":"provider_request"'));
      ok('trace: provider_response', trace.includes('"type":"provider_response"'));
      ok('trace: tool_start (Bash)', trace.includes('"type":"tool_start"'));
      ok('trace: tool_end', trace.includes('"type":"tool_end"'));
      ok('trace: session_end', trace.includes('"type":"session_end"'));
    }

    // T4 — Trajectory file (samples bucket, real counters)
    const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
    const failedPath = join(tmpHome, 'trajectories', 'failed.jsonl');
    ok('trajectory: samples.jsonl exists', existsSync(samplesPath), samplesPath);
    ok('trajectory: NOT in failed.jsonl', !existsSync(failedPath));
    if (existsSync(samplesPath)) {
      const traj = JSON.parse(readFileSync(samplesPath, 'utf8').trim()) as {
        sessionId: string;
        completed: boolean;
        terminalReason: string;
        toolCallCount: number;
        iterationsUsed: number;
        estimatedCostUsd: number;
        conversations: Array<{ from: string; value: string }>;
      };
      ok('trajectory: sessionId matches', traj.sessionId === sessionId);
      ok('trajectory: completed=true', traj.completed === true);
      ok(
        'trajectory: terminalReason=completed',
        traj.terminalReason === 'completed',
        `actual: ${traj.terminalReason}`,
      );
      ok(
        'trajectory: toolCallCount > 0',
        traj.toolCallCount > 0,
        `actual: ${traj.toolCallCount}`,
      );
      ok(
        'trajectory: iterationsUsed > 0',
        traj.iterationsUsed > 0,
        `actual: ${traj.iterationsUsed}`,
      );
      ok(
        'trajectory: estimatedCostUsd > 0',
        traj.estimatedCostUsd > 0,
        `actual: $${traj.estimatedCostUsd.toFixed(6)}`,
      );
      // ShareGPT mapping intentionally renders tool_result inline as `human`
      // with `<tool_result>` wrapping (src/trajectory/shareGpt.ts:50-66), not
      // a separate `tool` role. The `tool` branch in shareGpt.ts:92-100 is
      // unreachable in practice because tool_result blocks live in user
      // messages in the harness's internal Message representation.
      ok(
        'trajectory: human turns include tool_result wrapping',
        traj.conversations.some(
          (c) => c.from === 'human' && c.value.includes('<tool_result>'),
        ),
      );
      ok(
        'trajectory: assistant emitted tool_call',
        traj.conversations.some(
          (c) => c.from === 'gpt' && c.value.includes('<tool_call'),
        ),
      );
    }

    // T5 — Learning observations
    const projectId = getProjectId(tmpHome).id;
    const obsPath = join(tmpHome, 'learning', projectId, 'observations.jsonl');
    ok('observations file exists', existsSync(obsPath), obsPath);
    if (existsSync(obsPath)) {
      const obsLines = readFileSync(obsPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      ok('observations: at least one record', obsLines.length > 0);
      if (obsLines.length > 0) {
        const first = JSON.parse(obsLines[0]) as {
          tool_name: string;
          status: string;
        };
        ok('observations: tool_name=Bash', first.tool_name === 'Bash');
        ok(
          'observations: status is success or error',
          first.status === 'success' || first.status === 'error',
          `actual: ${first.status}`,
        );
      }
    }

    // T6 — session_summary event on disposal bus
    const summaryEvent = captured.find((e) => e.type === 'session_summary');
    ok('session_summary event fired', summaryEvent !== undefined);
    if (summaryEvent && summaryEvent.type === 'session_summary') {
      ok(
        'session_summary: sessionId matches',
        summaryEvent.sessionId === sessionId,
      );
      ok(
        'session_summary: totalDispatched >= 0',
        summaryEvent.totalDispatched >= 0,
        `actual: ${summaryEvent.totalDispatched}`,
      );
    }

    // T2 — DaemonEventBus reachable
    ok('runtime.daemonEventBus reachable', runtime.daemonEventBus !== undefined);
  } finally {
    await runtime.dispose();
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(2);
  console.log(`\n[smoke] elapsed: ${elapsed}s`);
  if (failed) {
    console.log('[smoke] RESULT: ❌ FAILED (see above)');
    preserveTmp = true;
    process.exitCode = 1;
  } else {
    console.log('[smoke] RESULT: ✅ PASSED — all per-session sinks verified against real Anthropic');
  }
} catch (err) {
  console.error('[smoke] EXCEPTION:', err);
  preserveTmp = true;
  process.exitCode = 1;
} finally {
  if (preserveTmp) {
    console.log(`[smoke] tmpHome preserved for inspection: ${tmpHome}`);
  } else {
    rmSync(tmpHome, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpHome}`);
  }
}
