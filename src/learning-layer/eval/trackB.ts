// src/learning-layer/eval/trackB.ts — Track-B full-loop runner.
//
// Track B proves the WHOLE learning loop with NO seeded instinct:
//
//   1. session N   — run the scenario's `setupTask` (recall OFF) via the
//                    `sov drive` binary so its tool calls accrue several
//                    consistent observations to observations.jsonl.
//   2. synthesis   — build an IN-PROCESS runtime against the same sandbox
//                    (cwd + harnessHome + db + learning-enabled config) and
//                    call runSynthesizer(...) directly, awaiting it. This is
//                    the REAL synthesizer sub-agent (this working tree's
//                    fixed confidence curve + clustering), invoked
//                    synchronously so we can verify the instinct before N+1.
//                    We do NOT lean on the binary's end-of-session trigger:
//                    `sov drive` exits before the fire-and-forget synthesizer
//                    completes, and the installed binary may carry the
//                    pre-fix near-zero-confidence curve.
//   3. verify      — read the corpus (project + _global) and confirm an
//                    instinct .md was written; log how many + trigger/action.
//   4. session N+1 — run the scenario's `task` twice: once with recall ON
//                    (the "with" arm) and once with recall OFF against the
//                    same corpus state (the "without"/baseline arm). Judge
//                    each; the flip is attributable to recall alone.
//
// Unlike Track A, both N+1 arms share ONE sandbox (the corpus from synthesis
// must be present in both). The arms differ ONLY by the recall config, so a
// flip is attributable to recall and nothing else.

import { runHarnessSession } from '../../../tests/semantic/framework/driver.js';
import type { Judge, SemanticTest } from '../../../tests/semantic/framework/types.js';
import { observationsPath } from '../../learning/paths.js';
import { getProjectId } from '../../learning/project.js';
import { runSynthesizer } from '../../learning/synthesizer.js';
import type { Instinct } from '../../learning/types.js';
import type { LearningScenario } from './scenarios/index.js';
import { type ArmResult, type ScenarioScore, scoreScenario } from './score.js';
import { readInstinctsForProject } from './trackBCorpus.js';

/** Per-arm binary timeout. Mirrors the Track-A arm timeout. */
const ARM_TIMEOUT_MS = 180_000;

/** Synthesis dispatch timeout — the synthesizer is a real sub-agent making
 *  model calls (read observations + cluster + propose). Generous headroom. */
const SYNTH_TIMEOUT_MS = 180_000;

/** Model the in-process synthesis runtime resolves to — matches the
 *  semantic driver's default agent model so the N/N+1 arms and the
 *  synthesizer share a model class. */
const SYNTH_MODEL = 'claude-sonnet-4-6';

/** Outcome of a Track-B run, including the loop-trace diagnostics the runner
 *  prints (observation count, synthesis result, instinct details, flip). */
export interface TrackBResult {
  readonly score: ScenarioScore;
  readonly without: ArmResult;
  readonly with: ArmResult;
  /** Number of observations session N accrued (lines in observations.jsonl). */
  readonly observationCount: number;
  /** Whether the synthesizer dispatch reported success. */
  readonly synthesisOk: boolean;
  /** The synthesizer's one-line summary (or the failure reason). */
  readonly synthesisDetail: string;
  /** Instincts present in the corpus AFTER synthesis (project + _global). */
  readonly instinctsWritten: readonly Instinct[];
}

/** Count observation lines in a JSONL file. Pure over the file contents. */
function countObservationLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

/** Build the synthetic SemanticTest the judge scores an N+1 arm against. */
function judgeTest(scenario: LearningScenario, arm: 'without' | 'with'): SemanticTest {
  return {
    id: `learning-${scenario.name}-${arm}`,
    name: `${scenario.name} (${arm} learning)`,
    description: `Track-B full-loop scenario "${scenario.name}", ${arm}-learning N+1 arm.`,
    category: 'workflow',
    prompt: scenario.task,
    judgeCriteria: {
      mustSatisfy: [...scenario.mustSatisfy],
      ...(scenario.shouldNot ? { shouldNot: [...scenario.shouldNot] } : {}),
    },
  };
}

/** Count completed tool calls in a `sov drive` transcript. Mirrors the
 *  runner's countToolCalls (kept local to avoid a circular import). */
function countToolCalls(transcript: string): number {
  const matches = transcript.match(/^\[result /gm);
  return matches ? matches.length : 0;
}

/** Run the IN-PROCESS synthesizer over session N's observations. Builds a
 *  real runtime against the sandbox so the dispatch uses the actual
 *  scheduler + tool pool + provider the runtime wires, then awaits the
 *  fire-and-forget synthesizer to completion (the ReviewManager voids it;
 *  here we await it directly so verification can follow).
 *
 *  Mutates process.env.{HARNESS_HOME,HARNESS_CONFIG} for the duration so the
 *  config loaders + project-id resolution read the sandbox state, then
 *  restores them. Single-process eval tool — this is acceptable and scoped. */
async function synthesizeInProcess(opts: {
  harnessHome: string;
  configPath: string;
  cwd: string;
  dbPath: string;
  bundleRoot: string;
  observationCount: number;
}): Promise<{ ok: boolean; detail: string }> {
  const prevHome = process.env.HARNESS_HOME;
  const prevConfig = process.env.HARNESS_CONFIG;
  process.env.HARNESS_HOME = opts.harnessHome;
  process.env.HARNESS_CONFIG = opts.configPath;

  const { buildRuntime } = await import('../../server/runtime.js');
  const runtime = await buildRuntime({
    cwd: opts.cwd,
    harnessHome: opts.harnessHome,
    dbPath: opts.dbPath,
    // Point at the runner-built bundle (declares projectId = the git id, and
    // carries the shipped agents so the instinct-synthesizer agent resolves).
    // This keeps the synthesis runtime, the observer, and recall all agreeing
    // on the git-remote project id — see runTrackBScenario's bundleDir doc.
    bundleRoot: opts.bundleRoot,
    // Pin provider + model so synthesis resolves deterministically against the
    // ambient ANTHROPIC_API_KEY (the sandbox config carries no credential) and
    // the synthesizer child runs on the same model class as the N/N+1 arms.
    provider: 'anthropic',
    model: SYNTH_MODEL,
    preflight: false,
    cronEnabled: false,
  });

  try {
    const project = getProjectId(opts.cwd);
    // Mint a real parent session row so the synthesizer's child session has a
    // valid parent reference (matches how the turns/sessions route mints one).
    const parentSessionId = runtime.sessionDb.createSession({
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
      metadata: { cwd: runtime.cwd, kind: 'track-b-synthesis-parent' },
    });
    const signal = new AbortController().signal;
    const synthPromise = runSynthesizer({
      scheduler: runtime.subagentScheduler,
      parentSessionId,
      parentSignal: signal,
      parentToolPool: runtime.toolPool,
      parentToolContext: {
        cwd: runtime.cwd,
        sessionId: parentSessionId,
        harnessHome: runtime.harnessHome,
        agents: runtime.agents,
        subagentScheduler: runtime.subagentScheduler,
        taskManager: runtime.taskManager,
        laneRegistry: runtime.laneRegistry,
        parentToolPool: runtime.toolPool,
      },
      harnessHome: runtime.harnessHome,
      projectId: project.id,
      projectName: project.name,
      recentObservationCount: opts.observationCount,
    });
    const result = await Promise.race([
      synthPromise,
      new Promise<{ ok: false; reason: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, reason: 'synthesis timed out' }), SYNTH_TIMEOUT_MS),
      ),
    ]);
    return result.ok ? { ok: true, detail: result.summary } : { ok: false, detail: result.reason };
  } finally {
    await runtime.dispose();
    restoreEnv('HARNESS_HOME', prevHome);
    restoreEnv('HARNESS_CONFIG', prevConfig);
  }
}

/** Restore one env var to its prior value, removing it when it was unset.
 *  Uses Reflect.deleteProperty so an originally-absent var doesn't become the
 *  literal string "undefined" (which a bare `= undefined` assignment causes). */
function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = prev;
  }
}

/** Run one N+1 arm against the (already-synthesized) shared sandbox. The
 *  sandbox config is rewritten between arms to flip recall on/off — the
 *  corpus on disk is untouched, so the only difference is whether recall
 *  splices the synthesized instinct in front of the turn. */
async function runNPlusOneArm(opts: {
  scenario: LearningScenario;
  arm: 'without' | 'with';
  binary: string;
  cwd: string;
  dbPath: string;
  bundleRoot: string;
  envAdditions: Record<string, string>;
  judge: Judge;
}): Promise<ArmResult> {
  const driver = await runHarnessSession({
    binary: opts.binary,
    // Point at an empty bundle dir so no bundle loads — the recall path's
    // project identity then resolves to the git-remote id, matching where the
    // synthesizer wrote the instinct. See runTrackBScenario for the why.
    extraArgs: ['--bundle', opts.bundleRoot],
    // Construct a Sandbox-shaped object pointing at the shared dirs. We reuse
    // the same cwd/db/home across both arms so the corpus persists; cleanup
    // is owned by the caller (the runner's createSandbox).
    sandbox: {
      rootDir: opts.cwd,
      cwd: opts.cwd,
      envAdditions: opts.envAdditions,
      dbPath: opts.dbPath,
      cleanup: () => {},
    },
    prompt: opts.scenario.task,
    timeoutMs: ARM_TIMEOUT_MS,
  });
  const verdictResult = await opts.judge(judgeTest(opts.scenario, opts.arm), driver.transcript);
  return { passed: verdictResult.pass, toolCalls: countToolCalls(driver.transcript) };
}

/** Full Track-B loop for one scenario. The caller owns the sandbox (creation
 *  + cleanup); this function drives session N, synthesis, verification, and
 *  both N+1 arms against it, writing the per-arm config as it goes. */
export async function runTrackBScenario(opts: {
  scenario: LearningScenario;
  binary: string;
  judge: Judge;
  cwd: string;
  harnessHome: string;
  configPath: string;
  dbPath: string;
  envAdditions: Record<string, string>;
  /** A minimal bundle dir (built by the runner's buildSandboxBundle) passed as
   *  `--bundle` to every session and to the synthesis runtime.
   *
   *  WHY a custom bundle: the write path (observer + synthesizer) derives the
   *  project id via getProjectId() — git-remote hash, else realpath hash. The
   *  recall read path derives it via resolveProjectScope(), which, when a
   *  bundle is loaded, prefers the bundle's declared `projectId` (else a hash
   *  of the bundle PATH). The default bundle declares none, so its path hash
   *  diverges from the git id and recall can't find a project-scoped instinct
   *  written under the git id. Synthesis, however, NEEDS the bundle (the
   *  `instinct-synthesizer` agent ships inside it). The runner's bundle
   *  resolves both halves: it carries the shipped agents AND declares
   *  projectId = the sandbox git id, so recall and synthesis agree. The
   *  default-bundle id divergence is a real finding in the Task-18 report. */
  bundleDir: string;
  /** Write the sandbox user config (recall on/off) before an arm runs. */
  writeConfig: (recallEnabled: boolean) => void;
  /** Read a file's contents (for observation counting). Returns '' if absent. */
  readFileSafe: (path: string) => string;
  log: (message: string) => void;
}): Promise<TrackBResult> {
  const { scenario, binary, judge, cwd, harnessHome, configPath, dbPath, envAdditions, bundleDir } =
    opts;
  if (scenario.setupTask === undefined) {
    throw new Error(`Track-B scenario "${scenario.name}" is missing setupTask`);
  }

  // --- Session N: generate observations (recall OFF). ----------------------
  opts.writeConfig(false);
  opts.log('   [N] running setup task to generate observations...');
  const sessionN = await runHarnessSession({
    binary,
    extraArgs: ['--bundle', bundleDir],
    sandbox: { rootDir: cwd, cwd, envAdditions, dbPath, cleanup: () => {} },
    prompt: scenario.setupTask,
    timeoutMs: ARM_TIMEOUT_MS,
  });
  const project = getProjectId(cwd);
  const obsPath = observationsPath(harnessHome, project.id);
  const observationCount = countObservationLines(opts.readFileSafe(obsPath));
  opts.log(
    `   [N] session N: ${countToolCalls(sessionN.transcript)} tool calls, ` +
      `${observationCount} observation(s) at ${obsPath}`,
  );

  // --- Synthesis: real synthesizer, in-process, awaited. -------------------
  opts.log(
    `   [synth] dispatching the live synthesizer over ${observationCount} observation(s)...`,
  );
  const synth = await synthesizeInProcess({
    harnessHome,
    configPath,
    cwd,
    dbPath,
    bundleRoot: bundleDir,
    observationCount: Math.max(observationCount, 1),
  });
  opts.log(`   [synth] ${synth.ok ? 'ok' : 'FAILED'}: ${synth.detail}`);

  // --- Verify: did an instinct land in the corpus? -------------------------
  const instinctsWritten = readInstinctsForProject(harnessHome, project.id);
  if (instinctsWritten.length === 0) {
    opts.log('   [verify] NO instinct written to corpus — the synthesis half did not yield.');
  } else {
    opts.log(`   [verify] ${instinctsWritten.length} instinct(s) in corpus:`);
    for (const inst of instinctsWritten) {
      opts.log(
        `   [verify]   - [${inst.scope}] confidence=${inst.confidence} ` +
          `trigger="${inst.trigger}" action="${inst.action}"`,
      );
    }
  }

  // --- Session N+1 (without recall = baseline). ----------------------------
  opts.writeConfig(false);
  const without = await runNPlusOneArm({
    scenario,
    arm: 'without',
    binary,
    cwd,
    dbPath,
    bundleRoot: bundleDir,
    envAdditions,
    judge,
  });
  opts.log(
    `   [N+1] without: ${without.passed ? 'PASS' : 'fail'} (${without.toolCalls} tool calls)`,
  );

  // --- Session N+1 (with recall). ------------------------------------------
  opts.writeConfig(true);
  const withArm = await runNPlusOneArm({
    scenario,
    arm: 'with',
    binary,
    cwd,
    dbPath,
    bundleRoot: bundleDir,
    envAdditions,
    judge,
  });
  opts.log(
    `   [N+1] with:    ${withArm.passed ? 'PASS' : 'fail'} (${withArm.toolCalls} tool calls)`,
  );

  const score = scoreScenario({ scenario: scenario.name, without, with: withArm });
  return {
    score,
    without,
    with: withArm,
    observationCount,
    synthesisOk: synth.ok,
    synthesisDetail: synth.detail,
    instinctsWritten,
  };
}
