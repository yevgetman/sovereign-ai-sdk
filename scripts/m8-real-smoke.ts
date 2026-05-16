#!/usr/bin/env bun
// M8 autonomous smoke test against REAL Anthropic (Haiku 4.5).
//
// Drives real turns through the production server runtime and asserts that
// every per-session subsystem M8 wired into SessionContext / Runtime lands
// its expected output, against the real provider the harness will use in
// prod. Inherits the M7 assertions (trace bookends, trajectory counters,
// learning observations, session_summary) and ADDS:
//
//   - T3 @file expansion: file contents inlined into the persisted user
//     message and the model's response references it.
//   - T3 subdirectory hints: AGENTS.md alongside the touched file appended
//     once to a tool_result.
//   - T4 skill discovery: GET /sessions/:id/skills returns the bundle-default
//     `review` skill.
//   - T5 skill-as-slash: POST with kind:'skill' expands the skill body server-
//     side before saveMessage.
//   - T7 rich session_summary: tokens.{input, estimatedCostUsd} > 0 and
//     toolCalls >= 1 (the smoke runs at least one tool).
//
// Stall detection (T7) is NOT exercised against the real provider — the model
// won't deterministically stall in a smoke turn. The mock-provider test in
// tests/server/turns.stallDetected.test.ts is the canonical pin for that wire
// surface. (See M8 plan: "Optional / skip if difficult.")
//
// Cost: ~$0.005-$0.01 per run on Haiku across 4 turns.
//
// Run: bun scripts/m8-real-smoke.ts

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const tmpHome = mkdtempSync(join(tmpdir(), 'sov-m8-real-'));
console.log(`[smoke] tmpHome: ${tmpHome}`);
console.log(`[smoke] HEAD: ${process.env.SOV_HEAD ?? '(see git log)'}`);
__test_resetProjectIdCache();

const startMs = Date.now();
let preserveTmp = false;
let failed = false;

const ok = (label: string, condition: boolean, detail?: string): void => {
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!condition) failed = true;
};

try {
  // ----- Pre-seed fixtures for T3 + T3-hints -----
  // T3 @file fixture — small known body we can grep for in the persisted user
  // message AND in the model's response (to prove the expansion reached the
  // model, not just the DB).
  const fixturePath = join(tmpHome, 'smoke-input.txt');
  writeFileSync(fixturePath, 'smoke fixture content from m8 real-Anthropic smoke run');

  // T3 subdirectory hint fixture — AGENTS.md alongside the touched directory.
  // The orchestrator's appendSubdirectoryHints appends this once per touched
  // directory across the session (see src/context/subdirectoryHints.ts:32).
  // We drop it at the cwd so a Bash `cd <tmpHome>` or a file tool touching
  // a file in <tmpHome> will pick it up.
  const hintPath = join(tmpHome, 'AGENTS.md');
  writeFileSync(
    hintPath,
    'This is a smoke test hint. If you see this, the subdirectory hint state is wired.\n',
  );

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
    console.log(
      `[smoke] traceWriter=${!!ctx.traceWriter} learning=${!!ctx.learningObserver} review=${!!ctx.reviewManager} subdirHints=${!!ctx.subdirectoryHintState}`,
    );

    // ----- T4 — skill discovery via GET /sessions/:id/skills BEFORE the first turn -----
    console.log('\n[smoke] T4: GET /sessions/:id/skills...');
    const skillsRes = await app.request(`/sessions/${sessionId}/skills`);
    if (skillsRes.status !== 200) {
      throw new Error(`GET /skills failed: ${skillsRes.status}`);
    }
    const skillsBody = (await skillsRes.json()) as {
      skills: Array<{ name: string; whenToUse: string; description: string }>;
    };
    const reviewSkill = skillsBody.skills.find((s) => s.name === 'review');
    const summarizeSkill = skillsBody.skills.find((s) => s.name === 'summarize');

    // (3) Drive turn 1 — Bash tool with @file expansion (T3).
    console.log('\n[smoke] turn 1: @file expansion + Bash tool against Anthropic...');
    const turn1Res = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:
          'Read @file:smoke-input.txt and use the Bash tool to run exactly: ' +
          'echo "hello from m8 smoke". Then in one sentence, state what the ' +
          'referenced file contained.',
      }),
    });
    if (turn1Res.status !== 202) {
      throw new Error(`turn 1 create failed: ${turn1Res.status}`);
    }
    const events1Res = await app.request(`/sessions/${sessionId}/events`);
    if (events1Res.status !== 200) {
      throw new Error(`turn 1 events stream failed: ${events1Res.status}`);
    }
    const sse1Body = await events1Res.text();
    const sawTurn1Complete = sse1Body.includes('"type":"turn_complete"');
    const sawTurn1Error = sse1Body.includes('"type":"turn_error"');
    console.log(
      `[smoke] turn 1 drained. turn_complete=${sawTurn1Complete} turn_error=${sawTurn1Error}`,
    );

    // ----- T5 — skill-as-slash dispatch -----
    // Use the `summarize` bundle skill (lightweight; matches a short prompt).
    // The route's POST handler parses the leading slash, expands the skill
    // body server-side, then continues into the normal turn loop.
    console.log('\n[smoke] turn 2: T5 skill-as-slash (/summarize) against Anthropic...');
    const skillTurnRes = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '/summarize Just respond with "summarize-skill-fired" in one word, do not actually summarize anything. This is a test.',
        kind: 'skill',
      }),
    });
    if (skillTurnRes.status !== 202) {
      throw new Error(`turn 2 (skill) create failed: ${skillTurnRes.status}`);
    }
    const events2Res = await app.request(`/sessions/${sessionId}/events`);
    if (events2Res.status !== 200) {
      throw new Error(`turn 2 events stream failed: ${events2Res.status}`);
    }
    const sse2Body = await events2Res.text();
    const sawTurn2Complete = sse2Body.includes('"type":"turn_complete"');
    const sawTurn2Error = sse2Body.includes('"type":"turn_error"');
    console.log(
      `[smoke] turn 2 drained. turn_complete=${sawTurn2Complete} turn_error=${sawTurn2Error}`,
    );

    // ----- T3 subdirectory hints — separate turn touching a fresh subdir -----
    // The first turn already touched tmpHome via Bash (cd-less echo runs in
    // cwd, which IS tmpHome). The hint state's dedup set will have tmpHome
    // recorded after that. Drop a NEW subdirectory + hint to drive a second
    // append; the persisted tool_result for THAT turn should carry the new
    // hint.
    const subdir = join(tmpHome, 'subdir-with-hint');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(
      join(subdir, 'AGENTS.md'),
      'HINT_FROM_SUBDIR: This subdirectory has its own hint file appended at the bottom of tool output.\n',
    );
    writeFileSync(join(subdir, 'target.txt'), 'subdir-target-content');

    console.log('\n[smoke] turn 3: T3 subdirectory hints (touch new subdir)...');
    const turn3Res = await app.request(`/sessions/${sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:
          'Use the Bash tool to run exactly: cd subdir-with-hint && cat target.txt. ' +
          'Then say "done-subdir" in one word.',
      }),
    });
    if (turn3Res.status !== 202) {
      throw new Error(`turn 3 create failed: ${turn3Res.status}`);
    }
    const events3Res = await app.request(`/sessions/${sessionId}/events`);
    const sse3Body = await events3Res.text();
    console.log(
      `[smoke] turn 3 drained. complete=${sse3Body.includes('"type":"turn_complete"')} error=${sse3Body.includes('"type":"turn_error"')}`,
    );

    // (5) Dispose with bus attached so session_summary lands.
    await runtime.disposeSession(sessionId, { bus: disposalBus });
    console.log('[smoke] session disposed.\n');

    // ============ Verification ============
    console.log('[smoke] verification:');

    // ----- M7 inherited: trace bookends -----
    const tracePath = join(tmpHome, 'traces', `${sessionId}.jsonl`);
    ok('M7 trace file exists', existsSync(tracePath), tracePath);
    if (existsSync(tracePath)) {
      const trace = readFileSync(tracePath, 'utf8');
      ok('M7 trace: session_start', trace.includes('"type":"session_start"'));
      ok('M7 trace: turn_start', trace.includes('"type":"turn_start"'));
      ok('M7 trace: provider_request', trace.includes('"type":"provider_request"'));
      ok('M7 trace: provider_response', trace.includes('"type":"provider_response"'));
      ok('M7 trace: tool_start (Bash)', trace.includes('"type":"tool_start"'));
      ok('M7 trace: tool_end', trace.includes('"type":"tool_end"'));
      ok('M7 trace: session_end', trace.includes('"type":"session_end"'));
    }

    // ----- M7 inherited: trajectory in samples.jsonl -----
    const samplesPath = join(tmpHome, 'trajectories', 'samples.jsonl');
    const failedPath = join(tmpHome, 'trajectories', 'failed.jsonl');
    ok('M7 trajectory: samples.jsonl exists', existsSync(samplesPath), samplesPath);
    ok('M7 trajectory: NOT in failed.jsonl', !existsSync(failedPath));
    if (existsSync(samplesPath)) {
      const traj = JSON.parse(readFileSync(samplesPath, 'utf8').trim()) as {
        sessionId: string;
        completed: boolean;
        terminalReason: string;
        toolCallCount: number;
        iterationsUsed: number;
        estimatedCostUsd: number;
      };
      ok('M7 trajectory: sessionId matches', traj.sessionId === sessionId);
      ok('M7 trajectory: completed=true', traj.completed === true);
      ok(
        'M7 trajectory: toolCallCount > 0',
        traj.toolCallCount > 0,
        `actual: ${traj.toolCallCount}`,
      );
      ok(
        'M7 trajectory: iterationsUsed > 0',
        traj.iterationsUsed > 0,
        `actual: ${traj.iterationsUsed}`,
      );
      ok(
        'M7 trajectory: estimatedCostUsd > 0',
        traj.estimatedCostUsd > 0,
        `actual: $${traj.estimatedCostUsd.toFixed(6)}`,
      );
    }

    // ----- M7 inherited: learning observations -----
    const projectId = getProjectId(tmpHome).id;
    const obsPath = join(tmpHome, 'learning', projectId, 'observations.jsonl');
    ok('M7 observations file exists', existsSync(obsPath), obsPath);
    if (existsSync(obsPath)) {
      const obsLines = readFileSync(obsPath, 'utf8').trim().split('\n').filter(Boolean);
      ok('M7 observations: at least one record', obsLines.length > 0);
      if (obsLines.length > 0) {
        // The smoke runs Bash explicitly in turns 1 and 3 — at least one
        // observation must record `tool_name: 'Bash'`. The model may also
        // pick FileRead on its own for turn 1 (since the prompt says "Read
        // @file:..."); both are valid model choices and a Bash run must
        // still land. Asserting "at least one Bash observation" rather
        // than "first observation is Bash" leaves the model free to choose
        // its own tool order while still pinning that the production
        // learning observer fired on the deterministic Bash call.
        const observations = obsLines.map((line) =>
          JSON.parse(line) as { tool_name: string; status: string },
        );
        const bashCount = observations.filter((o) => o.tool_name === 'Bash').length;
        ok(
          'M7 observations: at least one Bash observation',
          bashCount >= 1,
          `actual: ${bashCount} Bash / ${observations.length} total (tools: ${observations.map((o) => o.tool_name).join(', ')})`,
        );
      }
    }

    // ============ M8 NEW assertions ============

    // ----- T3 @file expansion -----
    // The expanded file body must land in the persisted user message
    // (sessionDb), proving the expansion ran BEFORE saveMessage. The model's
    // response should also reference the content — that proves the expansion
    // reached the model, not just the DB.
    const allMessages = runtime.sessionDb.loadMessages(sessionId);
    const userMessages = allMessages.filter((m) => m.role === 'user');
    const allUserText = JSON.stringify(userMessages.map((m) => m.content));
    ok(
      'M8 T3: @file body inlined into persisted user message',
      allUserText.includes('smoke fixture content from m8 real-Anthropic smoke run'),
    );
    ok('M8 T3: @file token replaced (no @file:smoke-input.txt literal)', !allUserText.includes('@file:smoke-input.txt'));

    // Model response references the content. Scan ASSISTANT messages for
    // turn 1 — the model was prompted "state what the referenced file
    // contained." Look for "smoke fixture content" in the assistant response.
    const assistantMessages = allMessages.filter((m) => m.role === 'assistant');
    const allAssistantText = JSON.stringify(assistantMessages.map((m) => m.content));
    ok(
      'M8 T3: model response references the expanded file content',
      /smoke fixture content/i.test(allAssistantText) || /smoke[-_ ]fixture/i.test(allAssistantText),
      `(looked for "smoke fixture content" or similar in assistant text)`,
    );

    // ----- T3 subdirectory hints -----
    // After turn 3 touched <tmpHome>/subdir-with-hint/, the orchestrator's
    // maybeAppendHints should have appended the AGENTS.md content from THAT
    // directory to the Bash tool_result. Scan persisted user messages for
    // the hint string AND the [subdirectory hints loaded] marker.
    // Note: tool_result blocks live in user messages in the harness's
    // internal Message representation.
    const sawHintMarker =
      allUserText.includes('[subdirectory hints loaded]') ||
      allUserText.includes('HINT_FROM_SUBDIR');
    ok(
      'M8 T3 hints: subdirectory hint appended to tool_result',
      sawHintMarker,
      sawHintMarker
        ? 'found hint marker or hint content'
        : 'no [subdirectory hints loaded] marker or HINT_FROM_SUBDIR found in user messages',
    );

    // ----- T4 skill discovery -----
    ok(
      'M8 T4: GET /skills returns array shape',
      Array.isArray(skillsBody.skills) && skillsBody.skills.length > 0,
      `actual length: ${skillsBody.skills.length}`,
    );
    ok(
      'M8 T4: GET /skills includes bundle-default "review"',
      reviewSkill !== undefined,
      reviewSkill ? `whenToUse: "${reviewSkill.whenToUse.slice(0, 60)}..."` : '(not found)',
    );
    ok(
      'M8 T4: GET /skills includes bundle-default "summarize"',
      summarizeSkill !== undefined,
      summarizeSkill ? `whenToUse: "${summarizeSkill.whenToUse.slice(0, 60)}..."` : '(not found)',
    );

    // ----- T5 skill-as-slash dispatch -----
    // The persisted user message for turn 2 should contain the EXPANDED skill
    // body (the summarize.md content), not the literal "/summarize ..." text.
    // We seeded turn 2 with `/summarize Just respond with "summarize-skill-fired"`.
    const sawExpansion =
      /Produce a tight, accurate summary/i.test(allUserText) || // summarize.md body content
      /Read with intent/i.test(allUserText); // also from summarize.md body
    ok(
      'M8 T5: skill body expanded in persisted user message',
      sawExpansion,
      sawExpansion
        ? 'found summarize skill body text'
        : 'no summarize skill body content found',
    );
    // The literal "/summarize ..." should NOT appear at the start of any
    // persisted message (the route stripped the slash command before
    // saveMessage). The arg "Just respond..." DOES appear (substituted into
    // the skill template), so we look specifically for the unexpanded prefix
    // "/summarize Just respond" — that exact sequence means the slash was
    // NOT processed.
    ok(
      'M8 T5: raw "/summarize" prefix replaced (not literal in saved text)',
      !/"role":"user"[^}]*"text":"\/summarize/i.test(allUserText),
    );

    // ----- T7 rich session_summary payload -----
    const summaryEvent = captured.find((e) => e.type === 'session_summary');
    ok('M8 T7: session_summary event fired', summaryEvent !== undefined);
    if (summaryEvent && summaryEvent.type === 'session_summary') {
      ok(
        'M8 T7 base: sessionId matches',
        summaryEvent.sessionId === sessionId,
      );
      ok('M8 T7 base: totalDispatched present', typeof summaryEvent.totalDispatched === 'number');
      // Rich M8 extension fields.
      const tokens = summaryEvent.tokens;
      ok(
        'M8 T7 rich: tokens present',
        tokens !== undefined,
        tokens ? JSON.stringify(tokens) : '(missing)',
      );
      if (tokens) {
        ok(
          'M8 T7 rich: tokens.input > 0 (real Anthropic billing)',
          tokens.input > 0,
          `actual: ${tokens.input}`,
        );
        ok(
          'M8 T7 rich: tokens.output > 0',
          tokens.output > 0,
          `actual: ${tokens.output}`,
        );
        ok(
          'M8 T7 rich: tokens.estimatedCostUsd > 0',
          tokens.estimatedCostUsd > 0,
          `actual: $${tokens.estimatedCostUsd.toFixed(6)}`,
        );
      }
      ok(
        'M8 T7 rich: toolCalls >= 1 (smoke ran at least one tool)',
        (summaryEvent.toolCalls ?? 0) >= 1,
        `actual: ${summaryEvent.toolCalls}`,
      );
    }

    // ----- T7 stall_detected wire schema sanity probe -----
    // (Not exercised against the real provider — see header comment.)
    // We parse a synthetic StallDetectedEvent through the Zod schema to
    // confirm the wire shape exists and the schema accepts the expected
    // fields. The mock-provider integration test in
    // tests/server/turns.stallDetected.test.ts is the canonical pin.
    const { parseServerEvent } = await import('../src/server/schema.ts');
    const stallProbe = parseServerEvent(
      JSON.stringify({
        type: 'stall_detected',
        seq: 1,
        sessionId,
        reason: 'no edits, no decisions, no memory writes for 3 turns',
        turn: 3,
      }),
    );
    ok(
      'M8 T7 (probe): StallDetectedEvent parses through Zod schema',
      stallProbe?.type === 'stall_detected',
      `parsed type: ${stallProbe?.type ?? 'null'}`,
    );

    // ----- Sanity: turn_complete observed on all three turns -----
    ok('M8 turn 1 (@file): turn_complete on SSE', sawTurn1Complete);
    ok('M8 turn 2 (/summarize): turn_complete on SSE', sawTurn2Complete);
    ok(
      'M8 turn 3 (subdir hints): turn_complete on SSE',
      sse3Body.includes('"type":"turn_complete"'),
    );

    // ----- Total cost across the session (echo for budget tracking) -----
    if (existsSync(samplesPath)) {
      const traj = JSON.parse(readFileSync(samplesPath, 'utf8').trim()) as {
        estimatedCostUsd: number;
      };
      console.log(`\n[smoke] total session cost: $${traj.estimatedCostUsd.toFixed(6)}`);
    }
  } finally {
    await runtime.dispose();
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(2);
  console.log(`\n[smoke] elapsed: ${elapsed}s`);
  if (failed) {
    console.log('[smoke] RESULT: FAILED (see above)');
    preserveTmp = true;
    process.exitCode = 1;
  } else {
    console.log(
      '[smoke] RESULT: PASSED -- all M7 + M8 per-session sinks verified against real Anthropic',
    );
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
