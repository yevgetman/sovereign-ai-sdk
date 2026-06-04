#!/usr/bin/env bun
// src/learning-layer/eval/runner.ts — with-vs-without learning eval runner.
//
// Proves Q1 (a recalled lesson changes behavior) by running each scenario in
// two arms that differ ONLY by learning config:
//   without — learning.recall.enabled = false (lessons on disk, never recalled)
//   with    — learning.recall.enabled = true  (recall splices lessons in front
//             of the turn) + review.autoPromote{Memory,Skills} = true so the
//             loop runs end-to-end with no human approval (D12).
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

import { runHarnessSession } from '../../../tests/semantic/framework/driver.js';
import { selectJudge } from '../../../tests/semantic/framework/judges/index.js';
import { createSandbox } from '../../../tests/semantic/framework/sandbox.js';
import type { Judge, SemanticTest } from '../../../tests/semantic/framework/types.js';
import { serializeInstinct } from '../../learning/instinctSerde.js';
import { GLOBAL_PROJECT_ID } from '../../learning/paths.js';
import { createFsPersist } from '../adapters/harness/persistFs.js';
import { scenarios } from './scenarios/index.js';
import type { LearningScenario } from './scenarios/index.js';
import { scoreScenario, verdict } from './score.js';
import type { ArmResult, ScenarioScore } from './score.js';

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

/** The learning config delta that distinguishes the two arms. This is the ONLY
 *  axis of difference between `without` and `with`. */
function armUserConfig(recallEnabled: boolean): Record<string, unknown> {
  if (!recallEnabled) {
    return { learning: { recall: { enabled: false } } };
  }
  return {
    learning: { recall: { enabled: true } },
    review: { autoPromoteMemory: true, autoPromoteSkills: true },
  };
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

  console.log(`learning eval: ${scenarios.length} scenario(s), binary=${binary}`);
  const scores: ScenarioScore[] = [];
  const armResults = new Map<string, { without: ArmResult; with: ArmResult }>();

  for (const scenario of scenarios) {
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

  printTable(scores, armResults);

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
