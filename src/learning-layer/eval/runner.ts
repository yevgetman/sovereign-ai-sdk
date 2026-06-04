#!/usr/bin/env bun
// src/learning-layer/eval/runner.ts — with-vs-without learning eval runner.
//
// Proves Q1 (a recalled lesson changes behavior) by running each scenario in
// two arms that differ ONLY by learning config:
//   without — learning.recall.enabled = false (lessons on disk, never recalled)
//   with    — learning.recall.enabled = true  (recall splices lessons in front
//             of the turn)
// Track A is a seeded single-turn proof, so recall is the SOLE axis of
// difference — the write-side review.autoPromote* flags are irrelevant here and
// deliberately omitted (see armUserConfig). Track B, which runs the full
// observe -> synthesize -> recall loop, owns its own config in trackB.ts.
//
// Each arm runs in its own isolated sandbox (config is baked into the sandbox
// at creation time), via the existing semantic-test driver (`sov drive`
// headless). Each arm's transcript is judged against the scenario's
// mustSatisfy/shouldNot via the framework judge, then scored
// (correctness flip + efficiency delta). The aggregate verdict gates exit.
//
// Reuses the semantic framework (driver + sandbox + judge) rather than
// duplicating it — this is a dev-only eval tool, never part of the shipped
// binary, so the src -> tests import is intentional (tsconfig includes both).

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHarnessSession } from '../../../tests/semantic/framework/driver.js';
import { selectJudge } from '../../../tests/semantic/framework/judges/index.js';
import { createSandbox } from '../../../tests/semantic/framework/sandbox.js';
import type { Judge, SemanticTest } from '../../../tests/semantic/framework/types.js';
import { serializeInstinct } from '../../learning/instinctSerde.js';
import { GLOBAL_PROJECT_ID } from '../../learning/paths.js';
import { tryGitProjectId } from '../../learning/project.js';
import { createFsPersist } from '../adapters/harness/persistFs.js';
import { scenarios } from './scenarios/index.js';
import type { LearningScenario } from './scenarios/index.js';
import { scoreScenario, verdict } from './score.js';
import type { ArmResult, ScenarioScore } from './score.js';
import { type TrackBResult, runTrackBScenario } from './trackB.js';

/** Per-arm binary timeout — each turn is a real model call; learning arms can
 *  trigger end-of-session synthesis, so give them generous headroom. */
const ARM_TIMEOUT_MS = 180_000;

/** Verdict bar for the spike: at least 3 correctness flips and no regressions. */
const MIN_FLIPS = 3;
const REPETITIONS = 1;

/** Binary under test — `sov` from PATH unless overridden (mirrors the semantic suite). */
function resolveBinary(): string {
  return process.env.SEMANTIC_BINARY ?? 'sov';
}

/** Count completed tool calls in a `sov drive` transcript. The driver emits
 *  one `[result <tool>]` line per tool_result, so this is one-per-invocation.
 *  Pure + deterministic so it can be unit-tested without a live run. */
export function countToolCalls(transcript: string): number {
  const matches = transcript.match(/^\[result /gm);
  return matches ? matches.length : 0;
}

/** The learning config delta that distinguishes the two arms. `learning.recall.enabled`
 *  is the ONLY axis of difference between `without` and `with`: both arms seed the same
 *  instinct corpus, so a flip is attributable to recall and nothing else. The Track-A
 *  scenarios are seeded single-turn tasks, so the write-side `review.autoPromote*` flags
 *  (which only govern whether review-fork-proposed memory/skills are written without human
 *  approval) are irrelevant here and deliberately omitted — keeping recall the sole delta. */
function armUserConfig(recallEnabled: boolean): Record<string, unknown> {
  return { learning: { recall: { enabled: recallEnabled } } };
}

/** Build the synthetic SemanticTest the judge scores an arm's transcript against. */
function judgeTest(scenario: LearningScenario, arm: 'without' | 'with'): SemanticTest {
  return {
    id: `learning-${scenario.name}-${arm}`,
    name: `${scenario.name} (${arm} learning)`,
    description: `Learning eval scenario "${scenario.name}", ${arm}-learning arm (track ${scenario.track}).`,
    category: 'workflow',
    prompt: scenario.task,
    judgeCriteria: {
      mustSatisfy: [...scenario.mustSatisfy],
      ...(scenario.shouldNot ? { shouldNot: [...scenario.shouldNot] } : {}),
    },
  };
}

/** Seed the scenario's instincts as GLOBAL-scope corpus entries under the
 *  sandbox harnessHome. Global scope sidesteps project-id derivation — recall
 *  always reads `_global` in addition to the active project. */
async function seedInstincts(harnessHome: string, scenario: LearningScenario): Promise<void> {
  const persist = createFsPersist(harnessHome);
  for (const seed of scenario.seedInstincts) {
    const key = `learning/${GLOBAL_PROJECT_ID}/instincts/${seed.instinct.id}.md`;
    await persist.write(key, serializeInstinct(seed.instinct, seed.body));
  }
}

/** Run one arm of a scenario in an isolated sandbox and judge the result.
 *  Both arms seed the same instinct corpus; only the recall config differs,
 *  so a flip is attributable to recall and nothing else. */
async function runArm(opts: {
  scenario: LearningScenario;
  arm: 'without' | 'with';
  recallEnabled: boolean;
  binary: string;
  judge: Judge;
}): Promise<ArmResult> {
  const { scenario, arm, recallEnabled, binary, judge } = opts;
  const files = Object.entries(scenario.sandbox).map(([path, content]) => ({ path, content }));
  const sandbox = createSandbox({
    setup: { files, userConfig: armUserConfig(recallEnabled) },
  });
  try {
    const harnessHome = sandbox.envAdditions.HARNESS_HOME;
    if (!harnessHome) throw new Error('sandbox did not expose HARNESS_HOME');
    await seedInstincts(harnessHome, scenario);

    const driver = await runHarnessSession({
      binary,
      sandbox,
      prompt: scenario.task,
      timeoutMs: ARM_TIMEOUT_MS,
    });

    const test = judgeTest(scenario, arm);
    const verdictResult = await judge(test, driver.transcript);
    return { passed: verdictResult.pass, toolCalls: countToolCalls(driver.transcript) };
  } finally {
    sandbox.cleanup();
  }
}

/** The arm config delta for Track B's N+1 arms. Same axis of difference as
 *  Track A (recall on/off), but Track B keeps a SINGLE sandbox across arms so
 *  the synthesized corpus persists; the config file is rewritten in place
 *  between arms instead of baking a fresh sandbox per arm. */
function writeTrackBConfig(configPath: string, recallEnabled: boolean): void {
  // Learning MUST be enabled so session N's observer writes observations and
  // the in-process synthesizer can read them. Recall flips per arm.
  const config = recallEnabled
    ? {
        learning: { disabled: false, recall: { enabled: true } },
        review: { autoPromoteMemory: true, autoPromoteSkills: true },
      }
    : { learning: { disabled: false, recall: { enabled: false } } };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/** Give the Track-B sandbox a stable, explicit project identity by making it
 *  a git repo with an `origin` remote. getProjectId() prefers the git remote
 *  hash; without a remote it falls back to a realpath hash (also stable for a
 *  fixed path), so this is belt-and-suspenders — it makes the identity
 *  git-derived and unambiguous, and matches how real projects are identified.
 *  Best-effort: a git failure leaves the realpath-hash fallback intact. */
function gitInitSandbox(cwd: string): void {
  const run = (args: string[]): void => {
    spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  };
  run(['init', '-q']);
  run(['remote', 'add', 'origin', 'https://example.com/sov/track-b-eval.git']);
}

/** Build a minimal sandbox bundle that closes the Track-B project-identity
 *  gap. The bundle's `index.yaml` declares `projectId: <id>`, which makes the
 *  recall path's resolveProjectScope() return that exact id — and we pass the
 *  sandbox's git-remote id, so it matches where the observer + synthesizer
 *  write (getProjectId()). The bundle also carries a copy of the shipped
 *  `bundle-default/agents/` so the in-process synthesizer runtime can resolve
 *  the `instinct-synthesizer` agent (agents are loaded from <bundle>/agents).
 *
 *  WHY a bundle at all (vs. running bundle-less): synthesis NEEDS the agent
 *  registry (the synthesizer agent ships in the bundle), but the default
 *  bundle's path-hash project id differs from the git id the write path uses —
 *  so neither "default bundle" nor "no bundle" closes the loop. A bundle that
 *  declares projectId = the git id satisfies both halves at once, and mirrors
 *  how a real Sovereign-AI deployment pins a stable bundle projectId. */
function buildSandboxBundle(bundleDir: string, projectId: string): void {
  mkdirSync(bundleDir, { recursive: true });
  const indexYaml = [
    'repo: track-b-eval',
    `projectId: ${projectId}`,
    'description: |',
    '  Minimal bundle for the Track-B learning-loop eval. Declares a projectId',
    '  matching the sandbox git id so recall and synthesis agree on identity.',
    'updated: 2026-06-03',
    '',
  ].join('\n');
  writeFileSync(join(bundleDir, 'index.yaml'), indexYaml);
  // Copy the shipped agents so the synthesizer (and review/routing agents)
  // resolve. Resolve bundle-default relative to this module so the path holds
  // regardless of the process cwd.
  const shippedAgents = join(import.meta.dir, '..', '..', '..', 'bundle-default', 'agents');
  cpSync(shippedAgents, join(bundleDir, 'agents'), { recursive: true });
}

/** Run one Track-B scenario end-to-end in its own sandbox. Owns sandbox
 *  creation + cleanup; delegates the loop (session N → synthesis → verify →
 *  N+1 arms) to runTrackBScenario. */
async function runTrackB(opts: {
  scenario: LearningScenario;
  binary: string;
  judge: Judge;
}): Promise<TrackBResult> {
  const { scenario, binary, judge } = opts;
  const files = Object.entries(scenario.sandbox).map(([path, content]) => ({ path, content }));
  // Seed with recall OFF (learning on) — writeTrackBConfig rewrites per arm.
  const sandbox = createSandbox({
    setup: {
      files,
      userConfig: { learning: { disabled: false, recall: { enabled: false } } },
    },
  });
  const harnessHome = sandbox.envAdditions.HARNESS_HOME;
  const configPath = sandbox.envAdditions.HARNESS_CONFIG;
  if (!harnessHome) throw new Error('sandbox did not expose HARNESS_HOME');
  if (!configPath) throw new Error('sandbox did not expose HARNESS_CONFIG');
  try {
    // Git-init FIRST so the project identity is established, then build a
    // bundle that declares that same git id as its projectId — this is what
    // makes the recall read path and the synthesis write path agree (see
    // buildSandboxBundle + runTrackBScenario's bundleDir doc).
    gitInitSandbox(sandbox.cwd);
    const gitProject = tryGitProjectId(sandbox.cwd);
    if (!gitProject) throw new Error('Track-B sandbox git identity not established');
    // Bundle lives under the sandbox root (outside cwd so the agent never sees
    // it as a project file) and is cleaned up with the sandbox.
    const bundleDir = join(sandbox.rootDir, 'bundle');
    buildSandboxBundle(bundleDir, gitProject.id);
    return await runTrackBScenario({
      scenario,
      binary,
      judge,
      cwd: sandbox.cwd,
      harnessHome,
      configPath,
      dbPath: sandbox.dbPath,
      bundleDir,
      envAdditions: sandbox.envAdditions,
      writeConfig: (recallEnabled) => writeTrackBConfig(configPath, recallEnabled),
      readFileSafe: (path) => {
        try {
          return readFileSync(path, 'utf-8');
        } catch {
          return '';
        }
      },
      log: (message) => console.log(message),
    });
  } finally {
    sandbox.cleanup();
  }
}

/** Print the per-scenario results table. */
function printTable(
  scores: readonly ScenarioScore[],
  armResults: ReadonlyMap<string, { without: ArmResult; with: ArmResult }>,
): void {
  console.log('');
  console.log('Scenario                         without  with   flip  regression  Δtools');
  console.log('-------------------------------- -------  ----   ----  ----------  ------');
  for (const s of scores) {
    const arms = armResults.get(s.scenario);
    const withoutPass = arms ? (arms.without.passed ? 'PASS' : 'fail') : '?';
    const withPass = arms ? (arms.with.passed ? 'PASS' : 'fail') : '?';
    const name = s.scenario.padEnd(32).slice(0, 32);
    const flip = s.flip ? 'yes' : 'no';
    const regression = s.regression ? 'YES' : 'no';
    const delta = s.efficiencyDelta >= 0 ? `+${s.efficiencyDelta}` : `${s.efficiencyDelta}`;
    console.log(
      `${name} ${withoutPass.padEnd(7)} ${withPass.padEnd(5)}  ${flip.padEnd(4)}  ${regression.padEnd(10)}  ${delta}`,
    );
  }
}

async function main(): Promise<void> {
  if (scenarios.length === 0) {
    console.log('learning eval: no scenarios — nothing to run.');
    const v = verdict([], { minFlips: MIN_FLIPS, repetitions: REPETITIONS });
    console.log(
      `summary: 0 scenarios, ${v.flips} flips, ${v.regressions} regressions (need >= ${MIN_FLIPS} flips, 0 regressions).`,
    );
    // No scenarios is a no-op, not a failure: exit 0 so the empty machinery
    // run is clean. The verdict bar only bites once scenarios exist.
    process.exit(0);
  }

  const binary = resolveBinary();
  const judge = await selectJudge({ backend: 'auto' });

  // Optional dev filter — `SOV_LEARNING_EVAL_ONLY=<substr>` runs only scenarios
  // whose name contains <substr>. Lets a developer iterate on one scenario
  // (e.g. the Track-B full loop) without paying for the whole suite. When set,
  // the MIN_FLIPS verdict bar may not be met — that's expected for a filtered
  // run; read the per-scenario table + Track-B trace instead.
  const only = process.env.SOV_LEARNING_EVAL_ONLY;
  const selected = only ? scenarios.filter((s) => s.name.includes(only)) : scenarios;
  if (only)
    console.log(`learning eval: SOV_LEARNING_EVAL_ONLY="${only}" -> ${selected.length} match(es)`);

  const trackA = selected.filter((s) => s.track === 'A');
  const trackB = selected.filter((s) => s.track === 'B');
  console.log(
    `learning eval: ${selected.length} scenario(s) (${trackA.length} track-A, ${trackB.length} track-B), binary=${binary}`,
  );
  const scores: ScenarioScore[] = [];
  const armResults = new Map<string, { without: ArmResult; with: ArmResult }>();
  const trackBResults: TrackBResult[] = [];

  // Track A — seeded-corpus, two-arm-per-sandbox proof (unchanged).
  for (const scenario of trackA) {
    console.log(`\n-> ${scenario.name} (track ${scenario.track})`);
    const without = await runArm({
      scenario,
      arm: 'without',
      recallEnabled: false,
      binary,
      judge,
    });
    console.log(
      `   without: ${without.passed ? 'PASS' : 'fail'} (${without.toolCalls} tool calls)`,
    );
    const withArm = await runArm({
      scenario,
      arm: 'with',
      recallEnabled: true,
      binary,
      judge,
    });
    console.log(
      `   with:    ${withArm.passed ? 'PASS' : 'fail'} (${withArm.toolCalls} tool calls)`,
    );
    armResults.set(scenario.name, { without, with: withArm });
    scores.push(scoreScenario({ scenario: scenario.name, without, with: withArm }));
  }

  // Track B — full-loop real-synthesis proof (session N → synthesize → N+1).
  for (const scenario of trackB) {
    console.log(`\n-> ${scenario.name} (track ${scenario.track}) [full loop]`);
    const result = await runTrackB({ scenario, binary, judge });
    armResults.set(scenario.name, { without: result.without, with: result.with });
    scores.push(result.score);
    trackBResults.push(result);
  }

  printTable(scores, armResults);

  if (trackBResults.length > 0) {
    console.log('');
    console.log('Track-B full-loop trace (observe -> synthesize -> recall):');
    for (const r of trackBResults) {
      const loopClosed = r.score.flip && r.instinctsWritten.length > 0;
      console.log(`  ${r.score.scenario}:`);
      console.log(`    observations from session N : ${r.observationCount}`);
      console.log(
        `    synthesis                   : ${r.synthesisOk ? 'ok' : 'FAILED'} — ${r.synthesisDetail}`,
      );
      console.log(`    instincts written           : ${r.instinctsWritten.length}`);
      console.log(`    N+1 flip (recall changed it): ${r.score.flip ? 'YES' : 'no'}`);
      console.log(`    full loop closed end-to-end : ${loopClosed ? 'YES' : 'no'}`);
    }
  }

  const v = verdict(scores, { minFlips: MIN_FLIPS, repetitions: REPETITIONS });
  console.log('');
  console.log(
    `summary: ${v.total} scenarios, ${v.flips} flips, ${v.regressions} regressions (need >= ${MIN_FLIPS} flips, 0 regressions).`,
  );
  console.log(v.pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(v.pass ? 0 : 1);
}

// Only run when invoked directly (`bun run src/learning-layer/eval/runner.ts`).
// Guarded so unit tests can import the pure helpers (e.g. countToolCalls)
// without triggering a live run + process.exit.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
