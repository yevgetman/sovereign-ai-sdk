// src/learning-layer/eval/scenarios/index.ts — curated + real-synthesis scenarios for the learning eval.
import type { Instinct } from '../../../learning/types.js';

export interface LearningScenario {
  readonly name: string;
  /** Files written into the sandbox cwd before the run (relative path -> contents). */
  readonly sandbox: Readonly<Record<string, string>>;
  /** Instincts seeded into the corpus (Track A). Empty for Track B (real synthesis). */
  readonly seedInstincts: readonly { readonly instinct: Instinct; readonly body: string }[];
  /** The dependent task run in the (N+1) session. */
  readonly task: string;
  /** Judge criteria deciding pass/fail of the task outcome. */
  readonly mustSatisfy: readonly string[];
  readonly shouldNot?: readonly string[];
  readonly track: 'A' | 'B';
  /** Track B ONLY — the session-N task. Run first (recall OFF, real tools)
   *  so its tool calls accrue several consistent observations of a learnable
   *  pattern. The runner then synthesizes those observations into an instinct
   *  and runs `task` (N+1) to test recall. Unused by Track A (seeded corpus,
   *  single session). Required when `track === 'B'`. */
  readonly setupTask?: string;
}

/** Fixed timestamps for seeded instincts — these are curated, not synthesized,
 *  so the exact dates are irrelevant to recall (assembly ranks by trigger-token
 *  overlap then confidence, never recency). Kept as constants for DRY. */
const SEED_TS = '2026-06-03T00:00:00.000Z';

/** Build a seed instinct with the curated-scenario defaults filled in. Every
 *  scenario's lesson is a GLOBAL-scope instinct (the runner seeds `_global`),
 *  high-confidence + high-evidence so it ranks first and survives the token
 *  budget. `domain` must be a valid InstinctDomainSchema enum member. */
function seed(fields: {
  readonly id: string;
  readonly trigger: string;
  readonly action: string;
  readonly domain: Instinct['domain'];
  readonly confidence?: number;
}): { readonly instinct: Instinct; readonly body: string } {
  return {
    instinct: {
      id: fields.id,
      trigger: fields.trigger,
      action: fields.action,
      confidence: fields.confidence ?? 0.85,
      evidence_count: 25,
      domain: fields.domain,
      scope: 'global',
      project_id: null,
      project_name: null,
      created_at: SEED_TS,
      last_evidence_at: SEED_TS,
      observation_ids: [],
    },
    body: '',
  };
}

// ---------------------------------------------------------------------------
// Track A — curated, deliberately NON-DERIVABLE scenarios.
//
// Each scenario is engineered so the "right" action is NOT discoverable from
// the sandbox files alone. The recall-OFF arm therefore takes the obvious
// (wrong) action; the recall-ON arm succeeds ONLY because the seeded instinct
// supplied a fact the agent could not have guessed. The instinct `trigger`
// lexically overlaps the `task` prompt so deterministic recall assembly
// (assemble.ts: matched-trigger-tokens / total-trigger-tokens > 0) surfaces it.
// ---------------------------------------------------------------------------
export const scenarios: LearningScenario[] = [
  // 1. UNUSUAL COMMAND. The canonical "wrong default" trap: there is no `test`
  //    script and the Makefile has no target named `test`. The Makefile exposes
  //    THREE plausible "run something that checks the code" targets — `check`
  //    (actually just the linter), `audit` (actually just a dependency scan),
  //    and `verify` (the REAL test target) — and none of their recipes announces
  //    itself as the suite: every recipe echoes a neutral line, so reading the
  //    Makefile reveals nothing about which target runs the tests. A baseline
  //    agent reaches for `npm test` / `bun test` (the universal default, absent
  //    here) or guesses one of the check-ish targets — most naturally `check`,
  //    since it literally reads as "check the code". Only the instinct names the
  //    exact target. Non-derivable: nothing in any file says the suite runs via
  //    `make verify` (vs `check`/`audit`), and `verify`'s `OK` output does not
  //    confirm it after the fact — the agent could not pick `verify` over its
  //    peers without the recalled fact.
  {
    name: 'unusual-test-command',
    sandbox: {
      Makefile: [
        '# Developer tasks. There is no `make test` target in this repo.',
        'check:',
        '\t@echo "lint: 0 problems"',
        '',
        'audit:',
        '\t@echo "0 vulnerabilities found"',
        '',
        'verify:',
        '\t@echo "OK"',
        '',
        'clean:',
        '\t@rm -rf dist',
        '',
      ].join('\n'),
      // No "test" script — the obvious default fails.
      'package.json': JSON.stringify(
        { name: 'demo', version: '1.0.0', scripts: { start: 'node index.js' } },
        null,
        2,
      ),
    },
    seedInstincts: [
      seed({
        id: 'testcmd',
        trigger: 'run the test suite in this repo',
        action:
          'run `make verify` — that is the test target. There is no npm or bun test script; `make check` only lints and `make audit` only scans dependencies. A passing run prints `OK`.',
        domain: 'testing',
      }),
    ],
    task: 'Run this repo’s test suite and tell me the result.',
    mustSatisfy: [
      'The agent ran the `make verify` command (the Makefile target named `verify`).',
      'The agent reported the suite passed (the `verify` target succeeded — its output was `OK`).',
    ],
    shouldNot: [
      'The agent ran `make check` and treated its lint output as the test result.',
      'The agent ran `make audit` and treated its dependency-scan output as the test result.',
      'The agent reported `npm test` or `bun test` as the way to run the suite.',
      'The agent concluded there is no way to run the tests.',
    ],
    track: 'A',
  },

  // 2. REPO CONVENTION (counterintuitive directory). New endpoint handlers in
  //    this repo must live in `src/handlers/`, NOT in `src/routes/` — the loader
  //    only scans `src/handlers/` and `src/routes/` is a dead legacy directory.
  //    This is deliberately counterintuitive: the existing `src/routes/users.ts`
  //    + `src/routes/orders.ts` are a DECOY that screams "put new routes here",
  //    so a baseline agent (matching the visible pattern) creates the file under
  //    src/routes/ — the obvious-but-wrong move. Nothing in any file says
  //    src/routes/ is dead or that handlers belong in src/handlers/; only the
  //    instinct carries that fact. Non-derivable: the real handler directory is
  //    stated nowhere and the sandbox actively points the wrong way.
  {
    name: 'handler-directory-convention',
    sandbox: {
      // Decoy: these make src/routes/ look like the obvious home for new routes.
      'src/routes/users.ts': "export function users() {\n  return 'users route';\n}\n",
      'src/routes/orders.ts': "export function orders() {\n  return 'orders route';\n}\n",
      'README.md': '# demo service\n\nAn HTTP service.\n',
    },
    seedInstincts: [
      seed({
        id: 'handlerdir',
        trigger: 'add a new endpoint handler in this repo',
        action:
          'create the new handler file under `src/handlers/`, NOT under `src/routes/` — the loader only scans src/handlers/ and src/routes/ is a dead legacy directory the loader ignores',
        domain: 'workflow',
      }),
    ],
    task: 'Add a new endpoint handler for a `health` endpoint that returns a status. Put it where the loader will actually pick it up in this repo.',
    mustSatisfy: [
      'The agent created the new health handler file under the src/handlers/ directory (e.g. src/handlers/health.ts).',
    ],
    shouldNot: [
      'The agent created the new handler file under src/routes/ (e.g. src/routes/health.ts).',
    ],
    track: 'A',
  },

  // 3. KNOWN PITFALL. The migration script is destructive unless `--safe` is
  //    passed. The script merely echoes (so running it is harmless in the
  //    sandbox), and NOTHING in the script or any file reveals that the bare
  //    form drops the dev table or that a `--safe` flag even exists. A baseline
  //    agent runs the script bare (the natural thing). Only the instinct knows
  //    about the flag and the danger. Non-derivable: the destructive behavior
  //    and the flag are invisible in the sandbox.
  {
    name: 'migrate-safe-flag',
    sandbox: {
      // The script just echoes its args — it can't teach the agent about the
      // danger or the flag.
      'scripts/migrate.sh': [
        '#!/usr/bin/env bash',
        'echo "migrate.sh invoked with args: $*"',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'demo-db', version: '1.0.0' }, null, 2),
    },
    seedInstincts: [
      seed({
        id: 'migratesafe',
        trigger: 'run the database migration script in this repo',
        action:
          'always invoke `./scripts/migrate.sh --safe` — running migrate.sh WITHOUT the --safe flag drops the dev table',
        domain: 'tooling',
      }),
    ],
    task: 'Run the database migration script for this repo.',
    mustSatisfy: [
      'The agent ran the migration script with the --safe flag (i.e. `./scripts/migrate.sh --safe` or `bash scripts/migrate.sh --safe`).',
    ],
    shouldNot: ['The agent ran ./scripts/migrate.sh without the --safe flag.'],
    track: 'A',
  },

  // 4. KNOWN PITFALL (counterintuitive build flag). The build silently reuses a
  //    poisoned cache and ships stale code unless `--no-cache` is passed. The
  //    build script just echoes its args, and NOTHING reveals the cache hazard
  //    or that a `--no-cache` flag even exists. This is counterintuitive: an
  //    agent told to "build" runs `./scripts/build.sh` with no flags (the
  //    natural move) — and would have no reason to suspect a cache problem.
  //    Only the instinct knows the flag and the hazard. Non-derivable: the
  //    stale-cache behavior and the flag are invisible in the sandbox. (Replaces
  //    the original codegen-before-build ordering scenario, whose "codegen then
  //    build" sequence the baseline derived from common sense — see Task 17
  //    triage.)
  {
    name: 'build-no-cache-flag',
    sandbox: {
      // The script just echoes its args — it can't teach the agent about the
      // cache hazard or the flag.
      'scripts/build.sh': ['#!/usr/bin/env bash', 'echo "build invoked with args: $*"', ''].join(
        '\n',
      ),
      'package.json': JSON.stringify({ name: 'demo-build', version: '1.0.0' }, null, 2),
    },
    seedInstincts: [
      seed({
        id: 'buildnocache',
        trigger: 'build the project in this repo',
        action:
          'always run `./scripts/build.sh --no-cache` — the default build reuses a poisoned cache and ships stale code; the --no-cache flag forces a clean build',
        domain: 'tooling',
      }),
    ],
    task: 'Build the project in this repo.',
    mustSatisfy: [
      'The agent ran the build script with the --no-cache flag (i.e. `./scripts/build.sh --no-cache` or `bash scripts/build.sh --no-cache`).',
    ],
    shouldNot: ['The agent ran ./scripts/build.sh without the --no-cache flag.'],
    track: 'A',
  },

  // 5. NON-DERIVABLE FACT (deploy region). The deploy must target a specific
  //    region; the default region has no production bucket and silently
  //    no-ops. The deploy script just echoes its args, and NOTHING in the
  //    sandbox reveals which region is correct (or that the default is wrong).
  //    A baseline agent runs the deploy script bare or guesses the common
  //    default. Only the instinct supplies the exact region. Non-derivable: the
  //    correct region (`eu-west-1`) is a pure fact the agent cannot infer.
  {
    name: 'deploy-target-region',
    sandbox: {
      'scripts/deploy.sh': [
        '#!/usr/bin/env bash',
        'echo "deploy.sh invoked with args: $*"',
        '',
      ].join('\n'),
      'README.md': '# demo app\n\nDeployed via scripts/deploy.sh.\n',
    },
    seedInstincts: [
      seed({
        id: 'deployregion',
        trigger: 'deploy the app using the deploy script in this repo',
        action:
          'always pass `--region eu-west-1` to ./scripts/deploy.sh — the default region (us-east-1) has no production bucket and the deploy silently no-ops',
        domain: 'tooling',
      }),
    ],
    task: 'Deploy the app using the deploy script in this repo.',
    mustSatisfy: [
      'The agent ran the deploy script passing the region eu-west-1 (e.g. `./scripts/deploy.sh --region eu-west-1`).',
    ],
    shouldNot: [
      'The agent ran ./scripts/deploy.sh without specifying a region.',
      'The agent deployed to us-east-1 (or any region other than eu-west-1).',
    ],
    track: 'A',
  },

  // ---------------------------------------------------------------------------
  // Track B — full-loop REAL-SYNTHESIS scenario (no seeded instinct).
  //
  // Unlike Track A (which seeds the corpus), Track B proves the WHOLE loop:
  //   session N  → repeated tool use generates consistent observations
  //   synthesis  → the live synthesizer clusters them into a real instinct
  //   session N+1 → recall surfaces that instinct and flips behavior
  //
  // The learnable fact is the mandatory `--strict` flag on the project's
  // `./bin/check` script. It is NON-DERIVABLE from the files: the script just
  // echoes its args, and nothing in the repo states that `--strict` is
  // required (or even exists). Session N learns it only because the setup
  // task drives `./bin/check --strict <file>` across five files — five
  // structurally-identical, all-success observations the synthesizer can
  // cluster and articulate sharply. Session N+1 ("check src/zeta.ts") would
  // run `./bin/check` bare in the baseline (the natural move) and only adds
  // `--strict` when the synthesized instinct is recalled. The instinct's
  // trigger ("check a file with ./bin/check in this repo") lexically overlaps
  // the N+1 prompt so deterministic recall assembly surfaces it.
  {
    name: 'project-check-strict-flag',
    sandbox: {
      // The checker just echoes its args — it teaches the agent NOTHING about
      // the --strict flag, so the requirement is genuinely non-derivable.
      'bin/check': ['#!/usr/bin/env bash', 'echo "check invoked with args: $*"', ''].join('\n'),
      'src/alpha.ts': 'export const alpha = 1;\n',
      'src/beta.ts': 'export const beta = 2;\n',
      'src/gamma.ts': 'export const gamma = 3;\n',
      'src/delta.ts': 'export const delta = 4;\n',
      'src/epsilon.ts': 'export const epsilon = 5;\n',
      'src/zeta.ts': 'export const zeta = 6;\n',
      // README frames bin/check as the checker but never mentions --strict.
      'README.md': '# demo lib\n\nSource lives in src/. Files are checked with ./bin/check.\n',
    },
    seedInstincts: [],
    // Session N — drive five consistent `./bin/check --strict <file>` calls.
    setupTask:
      'This project checks source files with ./bin/check, and in this repo every file MUST be checked with the --strict flag. Run `./bin/check --strict` on each of these files individually, one command per file, and report each result: src/alpha.ts, src/beta.ts, src/gamma.ts, src/delta.ts, src/epsilon.ts.',
    // Session N+1 — dependent task. Does NOT mention --strict; the baseline
    // has no reason to add it, so only a recalled instinct flips behavior.
    task: 'Check the file src/zeta.ts using this project’s checker.',
    mustSatisfy: [
      'The agent ran ./bin/check on src/zeta.ts WITH the --strict flag (e.g. `./bin/check --strict src/zeta.ts`).',
    ],
    shouldNot: ['The agent ran ./bin/check on src/zeta.ts WITHOUT the --strict flag.'],
    track: 'B',
  },
];
