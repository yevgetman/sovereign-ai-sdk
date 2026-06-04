// Learning-loop spike Phase 1 (Task 17) — recall BEHAVIOR semantic tests.
//
// These mirror the curated Track-A scenarios in
// src/learning-layer/eval/scenarios/index.ts as CI-visible semantic cases.
// Each one seeds a single high-confidence GLOBAL-scope instinct under
// HARNESS_HOME (learning/_global/instincts/<id>.md), enables per-turn recall
// + auto-promote in the sandbox user config, and prompts with the dependent
// task. The instinct's `trigger` lexically overlaps the prompt so the
// deterministic recall assembler (src/learning-layer/recall/assemble.ts)
// surfaces it ahead of the turn, and the judge then asserts the recalled
// lesson was actually applied.
//
// The scenarios are deliberately NON-DERIVABLE: the "right" action depends on
// a fact that appears in NO sandbox file, so an agent WITHOUT the recalled
// instinct would take the obvious-but-wrong action. The with-recall eval arm
// (`bun run eval:learning`) proves the flip against a baseline; these cases
// are the always-recall-on regression guard.
//
// Framework boundary: suite files never import from `src/`, so the instinct
// frontmatter is built inline by `instinctMarkdown` rather than reusing
// src/learning/instinctSerde.ts. The shape mirrors what serializeInstinct
// emits (YAML frontmatter matching InstinctSchema + empty markdown body).

import type { SemanticTest, TestSetupFile } from '../framework/types.js';

/** Minimal instinct shape needed to seed a corpus file. Mirrors the fields of
 *  the real Instinct type (src/learning/types.ts) without importing it. */
interface SeedInstinct {
  readonly id: string;
  readonly trigger: string;
  readonly action: string;
  readonly domain: 'code-style' | 'testing' | 'git' | 'debugging' | 'workflow' | 'tooling';
}

const SEED_TS = '2026-06-03T00:00:00.000Z';

/** Render a single-quoted YAML scalar, escaping embedded single quotes per the
 *  YAML spec (double them). Single-quoting keeps em-dashes and other punctuation
 *  in `action`/`trigger` literal so the value round-trips through
 *  src/learning/instinctSerde.ts's parseInstinct + InstinctSchema. */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build the on-disk instinct markdown (YAML frontmatter + empty body) for a
 *  high-confidence, high-evidence GLOBAL-scope instinct. */
function instinctMarkdown(i: SeedInstinct): string {
  const lines = [
    '---',
    `id: ${yamlScalar(i.id)}`,
    `trigger: ${yamlScalar(i.trigger)}`,
    `action: ${yamlScalar(i.action)}`,
    'confidence: 0.85',
    'evidence_count: 25',
    `domain: ${i.domain}`,
    'scope: global',
    'project_id: null',
    'project_name: null',
    `created_at: ${SEED_TS}`,
    `last_evidence_at: ${SEED_TS}`,
    'observation_ids: []',
    '---',
    '',
  ];
  return lines.join('\n');
}

/** Seed an instinct into the sandbox HARNESS_HOME at the GLOBAL-scope path the
 *  recall reader scans (learning/_global/instincts/<id>.md). */
function homeInstinct(i: SeedInstinct): TestSetupFile {
  return {
    path: `learning/_global/instincts/${i.id}.md`,
    content: instinctMarkdown(i),
  };
}

/** The user-config delta that turns recall on for the session AND lets the
 *  end-to-end learning loop run without human approval (mirrors the with-arm
 *  config in src/learning-layer/eval/runner.ts). */
const RECALL_ON_CONFIG: Record<string, unknown> = {
  learning: { recall: { enabled: true } },
  review: { autoPromoteMemory: true, autoPromoteSkills: true },
};

export const tests: SemanticTest[] = [
  {
    id: 'recall-unusual-test-command',
    name: 'recalled instinct routes the agent to the non-default test command',
    description:
      'There is no `test` script and the Makefile test target is named `ci` (next to a decoy ' +
      '`check` target that only lints). Without the recalled instinct the agent reaches for the ' +
      'universal default `npm test` / `bun test` (which do not exist here). The recalled instinct ' +
      'names the exact command — non-derivable because no file says the suite runs via `make ci`.',
    category: 'workflow',
    setup: {
      files: [
        {
          path: 'Makefile',
          content: [
            '# Developer tasks. NOTE: the test suite does NOT run via `make test`.',
            'check:',
            '\t@echo "lint: 0 problems"',
            '',
            'ci:',
            '\t@echo "ran 12 tests, all pass"',
            '',
            'clean:',
            '\t@rm -rf dist',
            '',
          ].join('\n'),
        },
        {
          path: 'package.json',
          content: JSON.stringify(
            { name: 'demo', version: '1.0.0', scripts: { start: 'node index.js' } },
            null,
            2,
          ),
        },
      ],
      homeFiles: [
        homeInstinct({
          id: 'testcmd',
          trigger: 'run the test suite in this repo',
          action:
            'run `make ci` — there is no npm or bun test script, and `make check` only lints; the suite is the `ci` target',
          domain: 'testing',
        }),
      ],
      userConfig: RECALL_ON_CONFIG,
    },
    prompt: 'Run this repo’s test suite and tell me the result.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent ran the `make ci` command (the Makefile target named `ci`).',
        'The agent reported the suite passed — specifically that 12 tests ran and all passed.',
      ],
      shouldNot: [
        'The agent ran `make check` and treated its lint output as the test result.',
        'The agent reported `npm test` or `bun test` as the way to run the suite.',
        'The agent concluded there is no way to run the tests.',
      ],
    },
    timeoutMs: 120_000,
  },
  {
    id: 'recall-handler-directory-convention',
    name: 'recalled instinct overrides the obvious directory with the real handler dir',
    description:
      'New endpoint handlers must live in src/handlers/, NOT src/routes/ — the loader only scans ' +
      'src/handlers/ and src/routes/ is a dead legacy directory. Counterintuitive: the existing ' +
      'src/routes/users.ts + orders.ts are a DECOY that points the wrong way, so without the ' +
      'instinct the agent creates the file under src/routes/. Non-derivable — the real handler ' +
      'directory is stated in no file and the sandbox actively misleads.',
    category: 'workflow',
    setup: {
      files: [
        {
          path: 'src/routes/users.ts',
          content: "export function users() {\n  return 'users route';\n}\n",
        },
        {
          path: 'src/routes/orders.ts',
          content: "export function orders() {\n  return 'orders route';\n}\n",
        },
        { path: 'README.md', content: '# demo service\n\nAn HTTP service.\n' },
      ],
      homeFiles: [
        homeInstinct({
          id: 'handlerdir',
          trigger: 'add a new endpoint handler in this repo',
          action:
            'create the new handler file under `src/handlers/`, NOT under `src/routes/` — the loader only scans src/handlers/ and src/routes/ is a dead legacy directory the loader ignores',
          domain: 'workflow',
        }),
      ],
      userConfig: RECALL_ON_CONFIG,
    },
    prompt:
      'Add a new endpoint handler for a `health` endpoint that returns a status. Put it where the loader will actually pick it up in this repo.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent created the new health handler file under the src/handlers/ directory (e.g. src/handlers/health.ts).',
      ],
      shouldNot: [
        'The agent created the new handler file under src/routes/ (e.g. src/routes/health.ts).',
      ],
    },
    timeoutMs: 120_000,
  },
  {
    id: 'recall-migrate-safe-flag',
    name: 'recalled instinct adds the required --safe flag to a destructive script',
    description:
      'migrate.sh drops the dev table unless `--safe` is passed. The script only echoes and no ' +
      'file reveals the danger or that the flag exists. Without the instinct the agent runs it ' +
      'bare; with it the agent passes --safe. Non-derivable — the destructive behavior and the ' +
      'flag are invisible in the sandbox.',
    category: 'workflow',
    setup: {
      files: [
        {
          path: 'scripts/migrate.sh',
          content: ['#!/usr/bin/env bash', 'echo "migrate.sh invoked with args: $*"', ''].join(
            '\n',
          ),
        },
        {
          path: 'package.json',
          content: JSON.stringify({ name: 'demo-db', version: '1.0.0' }, null, 2),
        },
      ],
      homeFiles: [
        homeInstinct({
          id: 'migratesafe',
          trigger: 'run the database migration script in this repo',
          action:
            'always invoke `./scripts/migrate.sh --safe` — running migrate.sh WITHOUT the --safe flag drops the dev table',
          domain: 'tooling',
        }),
      ],
      userConfig: RECALL_ON_CONFIG,
    },
    prompt: 'Run the database migration script for this repo.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent ran the migration script with the --safe flag (i.e. `./scripts/migrate.sh --safe` or `bash scripts/migrate.sh --safe`).',
      ],
      shouldNot: ['The agent ran ./scripts/migrate.sh without the --safe flag.'],
    },
    timeoutMs: 120_000,
  },
  {
    id: 'recall-build-no-cache-flag',
    name: 'recalled instinct adds the counterintuitive --no-cache build flag',
    description:
      'The build silently reuses a poisoned cache and ships stale code unless `--no-cache` is ' +
      'passed. The build script only echoes and no file reveals the cache hazard or the flag. ' +
      'Counterintuitive: an agent told to "build" runs the script bare and has no reason to suspect ' +
      'a cache problem. Non-derivable — the stale-cache behavior and the flag are invisible.',
    category: 'workflow',
    setup: {
      files: [
        {
          path: 'scripts/build.sh',
          content: ['#!/usr/bin/env bash', 'echo "build invoked with args: $*"', ''].join('\n'),
        },
        {
          path: 'package.json',
          content: JSON.stringify({ name: 'demo-build', version: '1.0.0' }, null, 2),
        },
      ],
      homeFiles: [
        homeInstinct({
          id: 'buildnocache',
          trigger: 'build the project in this repo',
          action:
            'always run `./scripts/build.sh --no-cache` — the default build reuses a poisoned cache and ships stale code; the --no-cache flag forces a clean build',
          domain: 'tooling',
        }),
      ],
      userConfig: RECALL_ON_CONFIG,
    },
    prompt: 'Build the project in this repo.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent ran the build script with the --no-cache flag (i.e. `./scripts/build.sh --no-cache` or `bash scripts/build.sh --no-cache`).',
      ],
      shouldNot: ['The agent ran ./scripts/build.sh without the --no-cache flag.'],
    },
    timeoutMs: 120_000,
  },
  {
    id: 'recall-deploy-target-region',
    name: 'recalled instinct supplies the non-default deploy region',
    description:
      'The deploy must target eu-west-1; the default region has no production bucket and silently ' +
      'no-ops. The deploy script only echoes and no file reveals the correct region. Without the ' +
      'instinct the agent runs the script bare or guesses the common default; with it the agent ' +
      'passes --region eu-west-1. Non-derivable — the correct region is a pure fact.',
    category: 'workflow',
    setup: {
      files: [
        {
          path: 'scripts/deploy.sh',
          content: ['#!/usr/bin/env bash', 'echo "deploy.sh invoked with args: $*"', ''].join('\n'),
        },
        { path: 'README.md', content: '# demo app\n\nDeployed via scripts/deploy.sh.\n' },
      ],
      homeFiles: [
        homeInstinct({
          id: 'deployregion',
          trigger: 'deploy the app using the deploy script in this repo',
          action:
            'always pass `--region eu-west-1` to ./scripts/deploy.sh — the default region (us-east-1) has no production bucket and the deploy silently no-ops',
          domain: 'tooling',
        }),
      ],
      userConfig: RECALL_ON_CONFIG,
    },
    prompt: 'Deploy the app using the deploy script in this repo.',
    judgeCriteria: {
      mustSatisfy: [
        'The agent ran the deploy script passing the region eu-west-1 (e.g. `./scripts/deploy.sh --region eu-west-1`).',
      ],
      shouldNot: [
        'The agent ran ./scripts/deploy.sh without specifying a region.',
        'The agent deployed to us-east-1 (or any region other than eu-west-1).',
      ],
    },
    timeoutMs: 120_000,
  },
];
