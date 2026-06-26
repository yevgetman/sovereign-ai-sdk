# Phase 1 — Multi-provider task routing · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of multi-provider task routing per the design at `specs/2026-05-23-multi-provider-task-routing-design.md`. Defaults provide a B-via-D bridge baseline (cost-lane sub-agents available even when disabled); `taskRouting.enabled: true` activates the delegator + decomposition flow.

**Architecture:** A `delegator` sub-agent (Sonnet-grade) becomes the parent's first action on every user turn when smart router is enabled. The delegator dispatches one or more atoms via `AgentTool` to cost-lane sub-agents (`cheap-task`, `moderate-task`, `frontier-task`), each backed by a configured provider/model. Synthesis is the final atom (lane chosen dynamically). All routing decisions are auditable via the existing sub-agent observability layer.

**Tech Stack:** TypeScript on Bun. Zod for config. Hono / SSE (existing). MockProvider for tests. Real Anthropic for semantic suite.

---

## Investigation findings (verified against the codebase)

These supersede the spec's "verify during implementation" notes. The plan tasks reflect the actual code paths.

1. **`role:` resolution lives in `src/runtime/scheduler.ts:374-401`** (NOT `src/agents/loader.ts`). The loader only parses the frontmatter; `SubagentScheduler.resolveProviderModel()` is where the resolution happens. It calls `findCapableModel` from `src/router/capabilities.ts:219-236`. The Phase 1 wire is a new `resolveLane?: (role: string) => LaneConfig | undefined` callback on `SubagentSchedulerOpts` consulted BEFORE the capability table.

2. **Parent system-prompt assembly lives in `src/context/systemPrompt.ts:147-183`.** Called from `src/server/runtime.ts:554-561` via `buildSystemSegments(...)`. The insertion point for the smart-router segment is a new option `smartRouterPrompt?: string` on `BuildSystemSegmentsOptions`.

3. **`AgentTool` IS in `SUBAGENT_EXCLUDED_TOOLS`** (`src/agents/exclusions.ts:18-33`). The delegator can't dispatch atoms by default. The current `filterToolsForChild` (`src/runtime/scheduler.ts:429-442`) is strict-allowlist. Phase 1 introduces:
   - `AgentDefinition.inheritParentTools?: boolean` — when `true`, switch the filter to "parent pool minus exclusions" (and minus exclusions reduced via `allowedSubagents`).
   - `AgentDefinition.allowedSubagents?: string[]` — when non-empty, bypass `AgentTool`'s exclusion and validate that any nested `AgentTool` call's `subagent_type` is in this list.

4. **Provider preflight call site is `src/server/runtime.ts:693-715`.** Lane preflight inserts after line 715, gated on `userSettings.taskRouting?.enabled === true`.

5. **Parent's primary system-prompt content is `bundle-default/business/system-prompt.md`** (NOT `CONTEXT.md`). This file gets the B-via-D bridge cost-lane mention.

6. **MockProvider** (Phase 18 T6) has `toolUseMode` + `slowMode` + `throwOnNext` + `lastSignal` static fields. Phase 1 adds `toolUseScript` for richer canned tool-use sequences.

7. **Semantic test framework**: cases live in `tests/semantic/suites/NN-name.cases.ts` as `export const tests: SemanticTest[] = [...]`. Pass `setup.userConfig` to control config. The runner spawns `sov drive` against a live LLM. Next available prefix is **22** (21-learning.cases.ts exists).

8. **Agent definition shape** (`src/agents/types.ts:19-35`): includes `name`, `description`, `whenToUse?`, `systemPrompt`, `allowedTools` (defaults `[]`), `model?` OR `role?`, `maxTurns` (default 50), `readOnly`, `supportsMissionState`. Phase 1 adds `inheritParentTools` and `allowedSubagents`.

**Two design refinements surfaced during investigation:**

- **R-B fix:** The delegator's model should be configurable via `taskRouting.delegator.model`. The delegator agent uses `role: delegator` (NOT literal `model:`). The lane registry treats `delegator` as a special non-cost-lane entry resolving to `taskRouting.delegator.model` (default `claude-sonnet-4-6`).
- **R-D fix:** Lane `timeoutMs` needs scheduler plumbing for per-delegation override. The scheduler's `DelegateInput` gains `perChildTimeoutMsOverride?: number`. `AgentTool.call` resolves the override from the target agent's role via `ctx.laneRegistry`.

---

## File structure

### Files to create

| Path | Purpose |
|---|---|
| `src/router/lanes.ts` | Pure `resolveLane(name, cfg): LaneConfig \| undefined` + `LANE_DEFAULTS` constant. |
| `src/router/laneRegistry.ts` | `buildLaneRegistry(cfg): LaneRegistry`; `lookup(role)` for cost lanes + delegator role. |
| `src/router/preflight.ts` | `runLanePreflight({ registry, harnessHome, resolveProvider })`; aggregates failures into `PreflightError`. |
| `bundle-default/agents/cheap-task.md` | `role: cheap-task`, `inheritParentTools: true`. |
| `bundle-default/agents/moderate-task.md` | `role: moderate-task`, `inheritParentTools: true`. |
| `bundle-default/agents/frontier-task.md` | `role: frontier-task`, `inheritParentTools: true`. Synthesis-aware prompt. |
| `bundle-default/agents/delegator.md` | `role: delegator`, `allowedSubagents: [cheap-task, moderate-task, frontier-task]`, `allowedTools: [AgentTool]`. The load-bearing prompt. |
| `bundle-default/prompts/smart-router.md` | System-prompt segment injected when `taskRouting.enabled: true`. |
| `tests/router/lanes.test.ts` | Unit tests. |
| `tests/router/laneRegistry.test.ts` | Unit tests. |
| `tests/router/preflight.test.ts` | Unit tests. |
| `tests/router/schedulerLaneResolve.test.ts` | Verify scheduler uses `resolveLane` before capability table. |
| `tests/router/smartRouter.endToEnd.test.ts` | End-to-end dispatch sequence test. |
| `tests/router/atomFailure.test.ts` | Atom failure → delegator continues → synthesis acknowledges gap. |
| `tests/router/atomTimeout.test.ts` | Lane `timeoutMs` enforcement. |
| `tests/agents/inheritParentTools.test.ts` | New frontmatter fields; tool-pool behavior; recursion guard. |
| `tests/agents/delegator.integration.test.ts` | Trivial-turn + compound-turn paths via MockProvider toolUseScript. |
| `tests/agents/delegator.definition.test.ts` | Load + frontmatter shape check. |
| `tests/semantic/suites/22-task-routing.cases.ts` | 5 real-LLM cases. |
| `tests/server/runtime.taskRouting.test.ts` | Runtime wiring tests. |
| `docs/07-history/state/2026-05-23-phase-1-task-routing.md` | Phase 1 close-out snapshot. |

### Files to modify

| Path | Change |
|---|---|
| `src/config/schema.ts` | Add `TaskRoutingSchema` + `LaneConfigSchema`; add `taskRouting?: ...` to `SettingsSchema`. |
| `src/agents/types.ts` | Add `inheritParentTools: boolean` + `allowedSubagents: string[]` fields. |
| `src/agents/loader.ts` | Extend `FrontmatterSchema` with the two new fields. |
| `src/agents/exclusions.ts` | Add `buildSubagentExclusions(agent)` helper. |
| `src/runtime/scheduler.ts` | Replace `filterToolsForChild` with `buildChildToolPool`; add `resolveLane` callback; add `perChildTimeoutMsOverride` on `DelegateInput`. |
| `src/tool/types.ts` | Add `parentAgentName?: string` to `ToolContext`. |
| `src/tools/AgentTool.ts` | Enforce `allowedSubagents` recursion guard. |
| `src/server/runtime.ts` | Build lane registry; run preflight; inject smart-router segment; pass `resolveLane` callback to scheduler. |
| `src/context/systemPrompt.ts` | Add `smartRouterPrompt?: string` option. |
| `bundle-default/business/system-prompt.md` | Add "Cost-lane sub-agents" section (B-via-D bridge baseline). |
| `src/providers/mock.ts` | Add `toolUseScript` static field for richer canned sequences. |
| `docs/03-cli-reference/usage.md` | Add "Multi-provider task routing" section. |
| `docs/06-testing/testing-log.md` | Append Phase 1 entry. |
| `CLAUDE.md` + `AGENTS.md` (byte-identical) | Update state pointer to point at the new close-out file. |
| `package.json` | Version bump `0.4.0 → 0.4.1`. |

---

## Task decomposition

19 tasks. Estimates assume subagent-driven execution per the project's calibration memory (~5x faster than human-time). Total estimated subagent wall-time: ~4-5 hours.

### T1 — `taskRouting` config schema (~10 min · Sonnet eligible)

**Files:**
- Modify: `src/config/schema.ts`
- Modify or create: `tests/config/schema.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/config/schema.test.ts — extend or create
import { describe, expect, test } from 'bun:test';
import { SettingsSchema } from '../../src/config/schema.js';

describe('taskRouting schema', () => {
  test('accepts a full override', () => {
    const parsed = SettingsSchema.parse({
      taskRouting: {
        enabled: true,
        delegator: { model: 'claude-sonnet-4-6' },
        lanes: {
          'cheap-task': {
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
          },
          'moderate-task': {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
          },
          'frontier-task': {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
          },
        },
      },
    });
    expect(parsed.taskRouting?.enabled).toBe(true);
    expect(parsed.taskRouting?.lanes?.['cheap-task']?.provider).toBe('anthropic');
  });
  test('empty taskRouting applies defaults', () => {
    const parsed = SettingsSchema.parse({ taskRouting: {} });
    expect(parsed.taskRouting?.enabled).toBe(false);
  });
  test('rejects negative timeoutMs', () => {
    expect(() => SettingsSchema.parse({
      taskRouting: {
        lanes: { 'cheap-task': { provider: 'anthropic', model: 'haiku', timeoutMs: -1 }},
      },
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config/schema.test.ts -t taskRouting`
Expected: FAIL — schema doesn't include `taskRouting`.

- [ ] **Step 3: Implement schema**

Add to `src/config/schema.ts`:

```typescript
export const LaneConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  allowedTools: z.array(z.string()).nullable().default(null),
  maxTokens: z.number().int().positive().nullable().default(null),
  timeoutMs: z.number().int().positive().default(120_000),
});

export type LaneConfig = z.infer<typeof LaneConfigSchema>;

export const TaskRoutingSchema = z.object({
  enabled: z.boolean().default(false),
  delegator: z
    .object({
      model: z.string().default('claude-sonnet-4-6'),
    })
    .default({}),
  lanes: z
    .object({
      'cheap-task': LaneConfigSchema.partial().optional(),
      'moderate-task': LaneConfigSchema.partial().optional(),
      'frontier-task': LaneConfigSchema.partial().optional(),
    })
    .default({}),
});

export type TaskRoutingConfig = z.infer<typeof TaskRoutingSchema>;
```

Add `taskRouting: TaskRoutingSchema.optional()` to `SettingsSchema`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/config/schema.test.ts -t taskRouting`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts tests/config/schema.test.ts
git commit -m "feat(config): add taskRouting schema for Phase 1 multi-provider routing"
```

---

### T2 — `src/router/lanes.ts` lane resolution (~12 min)

**Files:**
- Create: `src/router/lanes.ts`, `tests/router/lanes.test.ts`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/router/lanes.test.ts
import { describe, expect, test } from 'bun:test';
import { LANE_DEFAULTS, resolveLane } from '../../src/router/lanes.js';

describe('resolveLane', () => {
  test('returns default for cheap-task when no override', () => {
    const lane = resolveLane('cheap-task', undefined);
    expect(lane).toEqual(LANE_DEFAULTS['cheap-task']);
  });

  test('merges per-lane override with defaults', () => {
    const lane = resolveLane('cheap-task', {
      enabled: true,
      delegator: { model: 'claude-sonnet-4-6' },
      lanes: { 'cheap-task': { provider: 'ollama', model: 'qwen2.5:7b' }},
    } as never);
    expect(lane?.provider).toBe('ollama');
    expect(lane?.model).toBe('qwen2.5:7b');
    expect(lane?.timeoutMs).toBe(120_000); // inherited default
  });

  test('resolves delegator role to taskRouting.delegator.model', () => {
    const lane = resolveLane('delegator', {
      enabled: true,
      delegator: { model: 'claude-opus-4-7' },
      lanes: {},
    } as never);
    expect(lane?.provider).toBe('anthropic');
    expect(lane?.model).toBe('claude-opus-4-7');
  });

  test('unknown lane returns undefined', () => {
    expect(resolveLane('explore', undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/router/lanes.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/router/lanes.ts
import type { LaneConfig, TaskRoutingConfig } from '../config/schema.js';

export const LANE_DEFAULTS: Record<'cheap-task' | 'moderate-task' | 'frontier-task', LaneConfig> = {
  'cheap-task': {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    allowedTools: null,
    maxTokens: null,
    timeoutMs: 120_000,
  },
  'moderate-task': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    allowedTools: null,
    maxTokens: null,
    timeoutMs: 120_000,
  },
  'frontier-task': {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    allowedTools: null,
    maxTokens: null,
    timeoutMs: 120_000,
  },
};

const DELEGATOR_DEFAULTS: LaneConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  allowedTools: ['AgentTool'],
  maxTokens: null,
  timeoutMs: 120_000,
};

export function resolveLane(
  name: string,
  cfg: TaskRoutingConfig | undefined,
): LaneConfig | undefined {
  if (name === 'delegator') {
    return {
      ...DELEGATOR_DEFAULTS,
      model: cfg?.delegator.model ?? DELEGATOR_DEFAULTS.model,
    };
  }
  if (name === 'cheap-task' || name === 'moderate-task' || name === 'frontier-task') {
    const defaults = LANE_DEFAULTS[name];
    const override = cfg?.lanes?.[name];
    if (override === undefined) return defaults;
    return { ...defaults, ...override };
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/router/lanes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/router/lanes.ts tests/router/lanes.test.ts
git commit -m "feat(router): lane resolution module"
```

---

### T3 — `src/router/laneRegistry.ts` (~12 min)

**Files:**
- Create: `src/router/laneRegistry.ts`, `tests/router/laneRegistry.test.ts`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/router/laneRegistry.test.ts
import { describe, expect, test } from 'bun:test';
import { buildLaneRegistry } from '../../src/router/laneRegistry.js';

describe('LaneRegistry', () => {
  test('lookup returns defaults for known lane names', () => {
    const registry = buildLaneRegistry(undefined);
    expect(registry.lookup('cheap-task')?.model).toBe('claude-haiku-4-5-20251001');
    expect(registry.lookup('moderate-task')?.model).toBe('claude-sonnet-4-6');
    expect(registry.lookup('frontier-task')?.model).toBe('claude-opus-4-7');
    expect(registry.lookup('delegator')?.model).toBe('claude-sonnet-4-6');
  });

  test('lookup returns undefined for non-lane role', () => {
    const registry = buildLaneRegistry(undefined);
    expect(registry.lookup('explore')).toBeUndefined();
  });

  test('lookup honors per-lane override', () => {
    const registry = buildLaneRegistry({
      enabled: true,
      delegator: { model: 'claude-sonnet-4-6' },
      lanes: { 'cheap-task': { provider: 'ollama', model: 'qwen2.5:7b' } },
    } as never);
    expect(registry.lookup('cheap-task')?.provider).toBe('ollama');
  });
});
```

- [ ] **Step 2: RED.** `bun test tests/router/laneRegistry.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
// src/router/laneRegistry.ts
import type { LaneConfig, TaskRoutingConfig } from '../config/schema.js';
import { resolveLane } from './lanes.js';

export type LaneRegistry = {
  lookup: (role: string) => LaneConfig | undefined;
  entries: () => Array<{ name: string; config: LaneConfig }>;
};

const KNOWN_LANES = ['cheap-task', 'moderate-task', 'frontier-task', 'delegator'] as const;

export function buildLaneRegistry(cfg: TaskRoutingConfig | undefined): LaneRegistry {
  const map = new Map<string, LaneConfig>();
  for (const name of KNOWN_LANES) {
    const lane = resolveLane(name, cfg);
    if (lane !== undefined) map.set(name, lane);
  }
  return {
    lookup: (role) => map.get(role),
    entries: () => Array.from(map.entries()).map(([name, config]) => ({ name, config })),
  };
}
```

- [ ] **Step 4: GREEN.** Tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/router/laneRegistry.ts tests/router/laneRegistry.test.ts
git commit -m "feat(router): lane registry assembled from taskRouting config"
```

---

### T4 — `src/router/preflight.ts` boot-time validation (~15 min)

**Files:**
- Create: `src/router/preflight.ts`, `tests/router/preflight.test.ts`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/router/preflight.test.ts
import { describe, expect, test } from 'bun:test';
import { buildLaneRegistry } from '../../src/router/laneRegistry.js';
import { runLanePreflight } from '../../src/router/preflight.js';

describe('runLanePreflight', () => {
  test('resolves cleanly when all lanes preflight pass', async () => {
    const registry = buildLaneRegistry(undefined);
    await runLanePreflight({
      registry,
      harnessHome: '/tmp/test-home',
      resolveProvider: async () => ({ transport: { name: 'mock' }, model: 'x' } as never),
      preflight: async () => undefined,
    });
    // No throw = pass.
  });

  test('aggregates failures across lanes', async () => {
    const registry = buildLaneRegistry(undefined);
    let attempt = 0;
    await expect(
      runLanePreflight({
        registry,
        harnessHome: '/tmp/test-home',
        resolveProvider: async (provider) => {
          attempt++;
          throw new Error(`missing creds for ${provider}`);
        },
        preflight: async () => undefined,
      }),
    ).rejects.toThrow(/cheap-task.*moderate-task.*frontier-task/s);
    expect(attempt).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: RED.** Tests fail (module missing).

- [ ] **Step 3: Implement**

```typescript
// src/router/preflight.ts
import type { LaneRegistry } from './laneRegistry.js';

export type RunLanePreflightOpts = {
  registry: LaneRegistry;
  harnessHome: string;
  resolveProvider: (
    provider: string,
    model: string,
    opts: { harnessHome: string },
  ) => Promise<{ transport: { name: string }; model: string }>;
  preflight: (opts: {
    provider: { name: string };
    providerName: string;
    model: string;
  }) => Promise<void>;
};

export class LanePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LanePreflightError';
  }
}

export async function runLanePreflight(opts: RunLanePreflightOpts): Promise<void> {
  const failures: Array<{ lane: string; provider: string; model: string; reason: string }> = [];
  // Skip 'delegator' — its provider/model is verified by the existing
  // provider preflight when the parent's resolution uses anthropic.
  for (const { name, config } of opts.registry.entries()) {
    if (name === 'delegator') continue;
    try {
      const resolved = await opts.resolveProvider(config.provider, config.model, {
        harnessHome: opts.harnessHome,
      });
      await opts.preflight({
        provider: resolved.transport,
        providerName: resolved.transport.name,
        model: resolved.model,
      });
    } catch (err) {
      failures.push({
        lane: name,
        provider: config.provider,
        model: config.model,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failures.length === 0) return;
  const lines = failures.map(
    (f) => `  ${f.lane.padEnd(14)} ${f.provider}/${f.model}  — ${f.reason}`,
  );
  throw new LanePreflightError(
    `sov: cannot start with taskRouting enabled — preflight failures:\n${lines.join('\n')}\n\nSet credentials or override lanes in ~/.harness/config.json.`,
  );
}
```

- [ ] **Step 4: GREEN.** Tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/router/preflight.ts tests/router/preflight.test.ts
git commit -m "feat(router): boot-time lane preflight aggregating failures"
```

---

### T5 — Agent definition fields: `inheritParentTools` + `allowedSubagents` (~15 min)

**Files:**
- Modify: `src/agents/types.ts`, `src/agents/loader.ts`, `src/agents/exclusions.ts`.
- Create: `tests/agents/inheritParentTools.test.ts`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/agents/inheritParentTools.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentsFromDir } from '../../src/agents/loader.js';
import { buildSubagentExclusions, SUBAGENT_EXCLUDED_TOOLS } from '../../src/agents/exclusions.js';

describe('agent definition fields', () => {
  test('loader carries inheritParentTools and allowedSubagents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-'));
    writeFileSync(
      join(dir, 'tester.md'),
      `---
name: tester
description: Test agent
inheritParentTools: true
allowedSubagents:
  - cheap-task
  - moderate-task
model: claude-sonnet-4-6
maxTurns: 30
readOnly: false
---

Body text.`,
      'utf8',
    );
    const result = await loadAgentsFromDir(dir, 'user');
    const agent = result[0]!;
    expect(agent.inheritParentTools).toBe(true);
    expect(agent.allowedSubagents).toEqual(['cheap-task', 'moderate-task']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('defaults: inheritParentTools=false, allowedSubagents=[]', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-'));
    writeFileSync(
      join(dir, 'tester.md'),
      `---
name: tester
description: Test agent
model: claude-sonnet-4-6
maxTurns: 30
readOnly: false
---

Body.`,
      'utf8',
    );
    const result = await loadAgentsFromDir(dir, 'user');
    const agent = result[0]!;
    expect(agent.inheritParentTools).toBe(false);
    expect(agent.allowedSubagents).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildSubagentExclusions', () => {
  test('keeps AgentTool in exclusions when allowedSubagents is empty', () => {
    const agent = { allowedSubagents: [] } as never;
    const exclusions = buildSubagentExclusions(agent);
    expect(exclusions.has('AgentTool')).toBe(true);
    expect(exclusions.size).toBe(SUBAGENT_EXCLUDED_TOOLS.size);
  });

  test('removes AgentTool from exclusions when allowedSubagents is non-empty', () => {
    const agent = { allowedSubagents: ['cheap-task'] } as never;
    const exclusions = buildSubagentExclusions(agent);
    expect(exclusions.has('AgentTool')).toBe(false);
    expect(exclusions.size).toBe(SUBAGENT_EXCLUDED_TOOLS.size - 1);
  });
});
```

- [ ] **Step 2: RED.** Tests fail.

- [ ] **Step 3: Implement**

In `src/agents/types.ts`, extend `AgentDefinition`:

```typescript
export type AgentDefinition = {
  // ... existing fields ...
  inheritParentTools: boolean;
  allowedSubagents: string[];
};
```

In `src/agents/loader.ts`, extend the Zod frontmatter schema:

```typescript
const FrontmatterSchema = z
  .object({
    // ... existing fields ...
    inheritParentTools: z.boolean().default(false),
    allowedSubagents: z.array(z.string()).default([]),
  })
  .strict();
```

And thread through to the returned `AgentDefinition`.

In `src/agents/exclusions.ts`:

```typescript
import type { AgentDefinition } from './types.js';

// existing SUBAGENT_EXCLUDED_TOOLS stays unchanged

export function buildSubagentExclusions(
  agent: Pick<AgentDefinition, 'allowedSubagents'>,
): ReadonlySet<string> {
  if (!agent.allowedSubagents || agent.allowedSubagents.length === 0) {
    return SUBAGENT_EXCLUDED_TOOLS;
  }
  const reduced = new Set(SUBAGENT_EXCLUDED_TOOLS);
  reduced.delete('AgentTool');
  return reduced;
}
```

- [ ] **Step 4: GREEN.** Tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/types.ts src/agents/loader.ts src/agents/exclusions.ts tests/agents/inheritParentTools.test.ts
git commit -m "feat(agents): add inheritParentTools and allowedSubagents fields"
```

---

### T6 — Cost-lane sub-agent definitions + B-via-D bridge mention (~15 min · Sonnet eligible)

**Files:**
- Create: `bundle-default/agents/cheap-task.md`, `bundle-default/agents/moderate-task.md`, `bundle-default/agents/frontier-task.md`.
- Modify: `bundle-default/business/system-prompt.md`.

- [ ] **Step 1: Extend test from T5**

Append to `tests/agents/inheritParentTools.test.ts`:

```typescript
describe('bundled cost-lane agents', () => {
  test('cheap-task, moderate-task, frontier-task all use inheritParentTools=true', async () => {
    const dir = require('node:path').join(process.cwd(), 'bundle-default/agents');
    const result = await loadAgentsFromDir(dir, 'bundle');
    const byName = new Map(result.map((a) => [a.name, a]));
    for (const name of ['cheap-task', 'moderate-task', 'frontier-task']) {
      const agent = byName.get(name);
      expect(agent).toBeDefined();
      expect(agent?.inheritParentTools).toBe(true);
      expect(agent?.role).toBe(name);
    }
  });
});
```

- [ ] **Step 2: RED.** Tests fail (files don't exist).

- [ ] **Step 3: Create the agent files**

`bundle-default/agents/cheap-task.md`:

```markdown
---
name: cheap-task
description: Execute a single bounded task efficiently on the cheapest configured lane.
whenToUse: Use for atoms that don't require deep reasoning — file scanning, simple Q&A, syntax fixes, focused lookups.
role: cheap-task
inheritParentTools: true
maxTurns: 30
readOnly: false
---

You are a cost-efficient task executor. Your job is to complete ONE bounded task and return a tight result.

Working principles:
- Stay narrow. Do exactly what was asked; do not editorialize or expand scope.
- Use the minimum number of tool calls needed.
- Return a clear, structured response: a one-line summary at the top, then the substantive output.

Output shape:
- First line: a one-line summary digest.
- Remaining lines: the substantive output (file lists, file contents, brief analysis, etc.).
- Do not pad with explanations or restate the task.
```

`bundle-default/agents/moderate-task.md`:

```markdown
---
name: moderate-task
description: Execute a moderately complex task requiring multi-step reasoning on the moderate lane.
whenToUse: Use for atoms that need reasoning — multi-file analysis, design questions, structured generation, code understanding.
role: moderate-task
inheritParentTools: true
maxTurns: 50
readOnly: false
---

You are a mid-tier task executor. Your job is to complete one substantive task and return a structured result.

Working principles:
- Read the task carefully; identify what's actually being asked.
- Use tools to gather what you need; do not guess when you can verify.
- Return a structured result: one-line summary, then the substantive output.

Output shape:
- First line: a one-line summary digest.
- Remaining lines: the substantive output. Code, analysis, structured content as appropriate.
```

`bundle-default/agents/frontier-task.md`:

```markdown
---
name: frontier-task
description: Execute a hard-reasoning task or synthesize prior atom outputs on the frontier lane.
whenToUse: Use for atoms that need deep reasoning — security audits, architectural design, complex generation, or final synthesis of prior atom outputs.
role: frontier-task
inheritParentTools: true
maxTurns: 50
readOnly: false
---

You are a frontier-grade task executor. Your job is hard reasoning, complex synthesis, or careful generation.

Working principles:
- This is the most expensive lane; deliver value commensurate with the cost.
- Read the task carefully. If the prompt contains prior atom outputs labeled `Atom N output:`, integrate them into a coherent response.
- If any atom is labeled `Atom N (failed: <reason>)`, acknowledge the gap explicitly in your output. Do not paper over failures.
- Return a structured result.

Output shape:
- First line: a one-line summary digest.
- Remaining lines: the substantive output. For synthesis tasks, produce a coherent final response; do not just list the atom outputs.
```

- [ ] **Step 4: Update `bundle-default/business/system-prompt.md`**

Read the file first. Add a new section after the existing "What you have" content:

```markdown
## Cost-lane sub-agents

In addition to the role-specific sub-agents (explore, plan, verify, etc.), three cost-tier sub-agents are available for delegating work to a cheaper or more capable model when appropriate:

- **cheap-task** — Fast, cheap lane. Good for file scanning, simple Q&A, lookups, syntax fixes.
- **moderate-task** — Mid-tier reasoning. Good for multi-file analysis, design questions, structured generation.
- **frontier-task** — Hard reasoning + synthesis. Good for security audits, architectural design, integrating prior atom outputs into a coherent final response.

When a task fits one of these cleanly, delegating via AgentTool is preferred over doing it inline — it routes work to the cheapest sufficient model.
```

- [ ] **Step 5: GREEN.** Tests pass.

- [ ] **Step 6: Commit**

```bash
git add bundle-default/agents/cheap-task.md bundle-default/agents/moderate-task.md bundle-default/agents/frontier-task.md bundle-default/business/system-prompt.md tests/agents/inheritParentTools.test.ts
git commit -m "feat(bundle): cost-lane sub-agents + B-via-D bridge mention in parent prompt"
```

---

### T7 — Scheduler: lane-resolution hook + tool-pool inheritance (~30 min · Opus)

**Files:**
- Modify: `src/runtime/scheduler.ts`.
- Create: `tests/router/schedulerLaneResolve.test.ts`.

This is the highest-judgment task. The implementer must read `src/runtime/scheduler.ts` in full and make surgical changes that don't break existing scheduler tests.

- [ ] **Step 1: Read `src/runtime/scheduler.ts` carefully** — especially `resolveProviderModel` (~line 374-401) and `filterToolsForChild` (~line 429-442). Confirm field names match the investigation notes.

- [ ] **Step 2: Write failing tests**

```typescript
// tests/router/schedulerLaneResolve.test.ts
import { describe, expect, test } from 'bun:test';
import { SubagentScheduler } from '../../src/runtime/scheduler.js';
// ... import fixture helpers per existing tests/runtime/scheduler.test.ts ...

describe('SubagentScheduler — resolveLane callback', () => {
  test('uses resolveLane callback before falling back to capability table', () => {
    const scheduler = new SubagentScheduler({
      // existing required opts...
      resolveLane: (role: string) => {
        if (role === 'cheap-task') {
          return {
            provider: 'mock',
            model: 'mock-haiku',
            allowedTools: null,
            maxTokens: null,
            timeoutMs: 120_000,
          };
        }
        return undefined;
      },
    } as never);
    // Call resolveProviderModel with an agent having role='cheap-task';
    // assert returned (provider, model) is from the lane, not capability table.
  });

  test('falls back to capability table when resolveLane returns undefined', () => {
    // role: explore should still use findCapableModel.
  });

  test('child gets parent pool minus exclusions when inheritParentTools=true', () => {
    // Delegate with an agent that has inheritParentTools=true and
    // allowedSubagents=['cheap-task']; assert child's tool pool contains
    // AgentTool and the parent's other tools, but NOT the excluded tools.
  });

  test('child retains strict allowlist behavior when inheritParentTools=false', () => {
    // Regression guard for explore/plan/verify agents.
  });
});
```

- [ ] **Step 3: RED.** Tests fail.

- [ ] **Step 4: Implement scheduler changes**

a) Add `resolveLane` to `SubagentSchedulerOpts`:

```typescript
import type { LaneConfig } from '../config/schema.js';

export type SubagentSchedulerOpts = {
  // existing fields...
  resolveLane?: (role: string) => LaneConfig | undefined;
};
```

b) In `resolveProviderModel` (~line 374), consult `resolveLane` first:

```typescript
if (agent.role !== undefined && this.opts.resolveLane !== undefined) {
  const lane = this.opts.resolveLane(agent.role);
  if (lane !== undefined) {
    return { providerName: lane.provider, modelName: lane.model };
  }
}
// existing capability table fallback below
```

c) Rename `filterToolsForChild` to `buildChildToolPool` and accept the agent definition:

```typescript
import { buildSubagentExclusions } from '../agents/exclusions.js';

function buildChildToolPool<T extends { name: string }>(
  parentPool: T[],
  agent: AgentDefinition,
): T[] {
  if (agent.inheritParentTools) {
    const exclusions = buildSubagentExclusions(agent);
    return parentPool.filter((t) => !exclusions.has(t.name));
  }
  // Existing strict allowlist behavior (matches current filterToolsForChild)
  const allowed = new Set(agent.allowedTools);
  const exclusions = buildSubagentExclusions(agent);
  return parentPool.filter((t) => allowed.has(t.name) && !exclusions.has(t.name));
}
```

Update all call sites in `scheduler.ts` to use `buildChildToolPool(parentPool, agent)` instead of `filterToolsForChild(parentPool, allowed)`.

- [ ] **Step 5: GREEN.** New tests pass.

- [ ] **Step 6: Regression check**

Run: `bun test tests/runtime/scheduler.test.ts`
Expected: ALL EXISTING TESTS PASS (no behavior change for agents that don't set the new fields).

- [ ] **Step 7: Commit**

```bash
git add src/runtime/scheduler.ts tests/router/schedulerLaneResolve.test.ts
git commit -m "feat(scheduler): lane-aware role resolution and inherit-parent tool pool"
```

---

### T8 — `AgentTool` recursion check via `allowedSubagents` (~15 min)

**Files:**
- Modify: `src/tool/types.ts`, `src/tools/AgentTool.ts`, `src/runtime/scheduler.ts` (child ToolContext setup).
- Create: `tests/tools/AgentTool.allowedSubagents.test.ts`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/tools/AgentTool.allowedSubagents.test.ts
import { describe, expect, test } from 'bun:test';
// ... use the existing AgentTool test setup as reference ...

describe('AgentTool allowedSubagents enforcement', () => {
  test('rejects subagent_type not in parent agent allowedSubagents', async () => {
    // Build a ToolContext with parentAgentName='delegator' and an agents
    // registry where delegator has allowedSubagents=['cheap-task'].
    // Call AgentTool with subagent_type='frontier-task'; expect rejection.
  });

  test('allows subagent_type when it IS in allowedSubagents', async () => {
    // Same setup; call with subagent_type='cheap-task'; expect success.
  });

  test('no restriction when allowedSubagents is empty/undefined', async () => {
    // Build a ToolContext with parentAgentName=undefined OR a parent
    // agent with empty allowedSubagents; assert any subagent_type works
    // (regression guard).
  });
});
```

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement**

In `src/tool/types.ts`:

```typescript
export type ToolContext = {
  // existing fields...
  parentAgentName?: string;
};
```

In `src/tools/AgentTool.ts`, in the tool's `call` function:

```typescript
// Near the top, after input validation, before scheduler invocation
if (ctx.parentAgentName !== undefined && ctx.agents !== undefined) {
  const parentAgent = ctx.agents.byName.get(ctx.parentAgentName);
  if (parentAgent !== undefined && parentAgent.allowedSubagents.length > 0) {
    if (!parentAgent.allowedSubagents.includes(input.subagent_type)) {
      throw new Error(
        `AgentTool: parent agent '${ctx.parentAgentName}' is not allowed to invoke ` +
          `subagent_type '${input.subagent_type}'. Allowed: ${parentAgent.allowedSubagents.join(', ')}`,
      );
    }
  }
}
```

In `src/runtime/scheduler.ts`, in the place where the child's `ToolContext` is constructed (around lines 194-197 per investigation), set `parentAgentName: agent.name`.

- [ ] **Step 4: GREEN.**

- [ ] **Step 5: Commit**

```bash
git add src/tool/types.ts src/tools/AgentTool.ts src/runtime/scheduler.ts tests/tools/AgentTool.allowedSubagents.test.ts
git commit -m "feat(tools): enforce allowedSubagents recursion guard in AgentTool"
```

---

### T9 — Wire lane registry, preflight, smart-router segment into `buildRuntime` (~25 min · Opus)

**Files:**
- Modify: `src/server/runtime.ts`, `src/context/systemPrompt.ts`.
- Create: `tests/server/runtime.taskRouting.test.ts`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/server/runtime.taskRouting.test.ts
import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('buildRuntime — taskRouting wiring', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'rt-tr-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  test('runtime.laneRegistry exposes the configured lane', async () => {
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    const { buildRuntime } = await import('../../src/server/runtime.js');
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-haiku',
      cronEnabled: false,
    });
    expect(runtime.laneRegistry).toBeDefined();
    expect(runtime.laneRegistry.lookup('cheap-task')).toBeDefined();
    await runtime.dispose();
  });

  test('runtime.systemSegments includes smart-router segment when enabled', async () => {
    // Write user config with taskRouting.enabled=true; assert systemSegments
    // contains the smart-router prompt content.
  });

  test('runtime.systemSegments omits smart-router segment when disabled', async () => {
    // Default state — no smart-router segment.
  });
});
```

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement**

In `src/context/systemPrompt.ts`, add option:

```typescript
export type BuildSystemSegmentsOptions = {
  // existing fields...
  smartRouterPrompt?: string;
};
```

In `buildSystemSegments`, append a segment after bundle segments and before system context:

```typescript
if (options.smartRouterPrompt !== undefined && options.smartRouterPrompt.length > 0) {
  segments.push({
    text: options.smartRouterPrompt,
    cacheable: cacheEnabled,
  });
}
```

In `src/server/runtime.ts`:

a) After `readConfig` call, build the lane registry:

```typescript
import { buildLaneRegistry } from '../router/laneRegistry.js';
import { runLanePreflight } from '../router/preflight.js';

const laneRegistry = buildLaneRegistry(userSettings.taskRouting);
```

b) After the existing provider preflight call (~line 715), run lane preflight when enabled:

```typescript
if (opts.preflight !== false && userSettings.taskRouting?.enabled === true) {
  await runLanePreflight({
    registry: laneRegistry,
    harnessHome,
    resolveProvider: (provider, model, ropts) => resolveProvider(provider, model, ropts),
    preflight: preflightProvider,
  });
}
```

c) Pass `resolveLane` into `SubagentScheduler` opts:

```typescript
new SubagentScheduler({
  // existing opts...
  resolveLane: (role) => laneRegistry.lookup(role),
})
```

d) When `taskRouting.enabled === true`, load the smart-router prompt:

```typescript
let smartRouterPrompt: string | undefined;
if (userSettings.taskRouting?.enabled === true && bundle !== null) {
  const promptPath = join(bundle.bundleRoot, 'prompts', 'smart-router.md');
  try {
    smartRouterPrompt = await readFile(promptPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`[taskRouting] smart-router prompt not found at ${promptPath}; segment skipped`);
    } else {
      throw err;
    }
  }
}
```

Pass `smartRouterPrompt` into `buildSystemSegments(...)`.

e) Add `laneRegistry: LaneRegistry` to `Runtime` type and assign it.

- [ ] **Step 4: GREEN.**

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime.ts src/context/systemPrompt.ts tests/server/runtime.taskRouting.test.ts
git commit -m "feat(runtime): wire taskRouting lane registry, preflight, scheduler hook"
```

---

### T10 — Delegator agent definition (~25 min · Opus)

**Files:**
- Create: `bundle-default/agents/delegator.md`.
- Create: `tests/agents/delegator.definition.test.ts`.

- [ ] **Step 1: Write failing test**

```typescript
// tests/agents/delegator.definition.test.ts
import { describe, expect, test } from 'bun:test';
import { loadAgentsFromDir } from '../../src/agents/loader.js';
import { join } from 'node:path';

describe('delegator agent definition', () => {
  test('loads with correct frontmatter', async () => {
    const dir = join(process.cwd(), 'bundle-default/agents');
    const agents = await loadAgentsFromDir(dir, 'bundle');
    const delegator = agents.find((a) => a.name === 'delegator');
    expect(delegator).toBeDefined();
    expect(delegator?.role).toBe('delegator');
    expect(delegator?.allowedSubagents).toEqual([
      'cheap-task',
      'moderate-task',
      'frontier-task',
    ]);
    expect(delegator?.allowedTools).toContain('AgentTool');
    expect(delegator?.inheritParentTools).toBeFalsy();
    expect(delegator?.systemPrompt).toContain('lane');
    expect(delegator?.systemPrompt).toContain('AgentTool');
    expect(delegator?.systemPrompt).toContain('synthesis');
  });
});
```

- [ ] **Step 2: RED.**

- [ ] **Step 3: Create `bundle-default/agents/delegator.md`**

```markdown
---
name: delegator
description: Smart router. Decomposes a user turn into one or more atoms and dispatches each to the cheapest sufficient cost-lane sub-agent.
whenToUse: Invoked automatically as the parent's first action on every user turn when taskRouting.enabled is true. Not invoked directly by the user.
role: delegator
allowedTools:
  - AgentTool
allowedSubagents:
  - cheap-task
  - moderate-task
  - frontier-task
maxTurns: 50
readOnly: false
---

You are the smart router. Your job is to take a user task and dispatch it to one or more cost-lane sub-agents, returning a coherent final response.

## Lane catalogue

- **cheap-task** (Haiku-grade, configured lane): file scanning, simple Q&A, focused lookups, syntax fixes. Use for atoms that don't require reasoning.
- **moderate-task** (Sonnet-grade): multi-file analysis, design questions, structured generation, code understanding. Use for atoms that need real reasoning.
- **frontier-task** (Opus-grade): hard reasoning, security audits, architectural design, complex synthesis. Use for atoms where capability matters more than cost.

## Decision rule (apply on every invocation)

1. **Trivial task** (single claim, single lookup, conversational reply): dispatch ONE atom on cheap-task or moderate-task as appropriate. NO synthesis step. Return that atom's output verbatim.

2. **Compound task with N independent sub-questions**: decompose into N atoms (lanes chosen per sub-question complexity), then dispatch ONE final synthesis atom (lane chosen per synthesis difficulty — usually frontier-task for hard synthesis, moderate-task for medium). The synthesis atom receives prior atom outputs in its prompt.

3. **Hard-reasoning single question** ("design a permission model", "audit this code for security"): ONE atom on frontier-task. NO synthesis step (the atom IS the synthesis).

## Synthesis-atom pattern

When dispatching a synthesis atom, structure its prompt like:

```
[original user task]

Prior atom outputs:

Atom 1 output:
[summary or full output of atom 1]

Atom 2 output:
[summary or full output of atom 2]

...

Integrate these into a coherent response.
```

If any prior atom failed (terminal reason not 'completed'), label it explicitly:

```
Atom 2 (failed: max_turns):
<partial output if any>
```

The frontier-task agent has special handling for this pattern and will acknowledge gaps to the user.

## Failure handling

- If an atom returns a terminal reason other than `completed` or `max_turns`, do NOT re-dispatch.
- Continue with remaining atoms.
- In the synthesis prompt, mark the failed atom with `Atom N (failed: <reason>):` so synthesis acknowledges the gap.

## Output

Return the final atom's response. For trivial single-atom turns, return that atom's response directly. Do not add commentary, preamble, or restatement.

## Constraints

- You may only call AgentTool. No other tools are in your pool.
- You may only dispatch to cheap-task, moderate-task, or frontier-task. Other subagent_types are blocked.
- Keep your own reasoning tight. Each turn of your own thinking is a cost you pay before any atom is dispatched.
```

- [ ] **Step 4: GREEN.**

- [ ] **Step 5: Commit**

```bash
git add bundle-default/agents/delegator.md tests/agents/delegator.definition.test.ts
git commit -m "feat(bundle): delegator agent definition for smart router"
```

---

### T11 — Smart-router system prompt segment (~5 min)

**Files:**
- Create: `bundle-default/prompts/smart-router.md`.

- [ ] **Step 1: Create the file**

```markdown
<smart-router>
Smart router is active.

On every user turn, your FIRST action MUST be:

  AgentTool(subagent_type: "delegator", prompt: <the user's turn, including any conversation context the delegator should know about>)

The delegator decides whether to single-shot the task on a cheap lane or decompose it into multiple atoms. It returns the final response.

Relay the delegator's `summary` field as your assistant message verbatim. Light wordsmithing only when needed for fluency — do not add preamble, do not restate the question, do not editorialize on the routing decision.

When the current turn is a follow-up that depends on prior turns, include a one-sentence `conversation_context` field in the delegator's prompt so it can plan with the right context. Keep it short.
</smart-router>
```

- [ ] **Step 2: Pre-commit gate**

```bash
bun run lint && bun run typecheck && bun run test
```

- [ ] **Step 3: Commit**

```bash
git add bundle-default/prompts/smart-router.md
git commit -m "feat(bundle): smart-router system-prompt segment"
```

---

### T12 — MockProvider toolUseScript for richer test sequences (~15 min)

**Files:**
- Modify: `src/providers/mock.ts`.
- Create: `tests/providers/mock.toolUseScript.test.ts`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/providers/mock.toolUseScript.test.ts
import { afterEach, describe, expect, test } from 'bun:test';
import { MockProvider } from '../../src/providers/mock.js';

describe('MockProvider.toolUseScript', () => {
  afterEach(() => { MockProvider.toolUseScript = undefined; });

  test('walks the script across successive stream calls', async () => {
    MockProvider.toolUseScript = [
      { kind: 'tool_use', name: 'AgentTool', input: { subagent_type: 'cheap-task', prompt: 'x' }},
      { kind: 'text', text: 'final answer' },
    ];
    const provider = new MockProvider();
    // Call stream() twice; assert first emits tool_use, second emits text.
    // Use the existing MockProvider test helpers / streamCallsHistory.
  });

  test('falls back to legacy toolUseMode behavior when script is unset', async () => {
    MockProvider.toolUseMode = true;
    // Existing behavior; assert echo-hello sequence.
  });
});
```

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement**

Read the existing `src/providers/mock.ts` to understand the streaming pattern. Add:

```typescript
export type ToolCallScript =
  | { kind: 'tool_use'; name: string; input: unknown; id?: string }
  | { kind: 'text'; text: string };

export class MockProvider {
  // existing static fields (toolUseMode, slowMode, slowModeDelayMs, lastSignal, throwOnNext, etc.)
  static toolUseScript: ToolCallScript[] | undefined = undefined;
  private static scriptCursor = 0;

  // In stream(), when toolUseScript is set, consume one entry per call:
  // - 'tool_use' → emit a tool_use_start + tool_use_input_partial chunk
  //   sequence + message_stop with stop_reason='tool_use'.
  // - 'text' → emit text_delta sequence + message_stop with stop_reason='end_turn'.
  //
  // Reset scriptCursor to 0 only when toolUseScript is reassigned (handle via setter or
  // explicit reset method).
}
```

The legacy `toolUseMode` path stays unchanged; the new script-based path activates when `toolUseScript !== undefined`.

- [ ] **Step 4: GREEN.**

- [ ] **Step 5: Commit**

```bash
git add src/providers/mock.ts tests/providers/mock.toolUseScript.test.ts
git commit -m "feat(providers): MockProvider.toolUseScript for richer canned sequences"
```

---

### T13 — Integration test: trivial turn → 1 atom (~25 min · Opus)

**Files:**
- Create: `tests/agents/delegator.integration.test.ts`.

- [ ] **Step 1: Write failing test**

```typescript
// tests/agents/delegator.integration.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../../src/providers/mock.js';

describe('delegator integration — trivial turn', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'deleg-int-'));
    mkdirSync(join(home, 'sov'), { recursive: true });
    writeFileSync(
      join(home, 'sov', 'config.json'),
      JSON.stringify({
        provider: 'mock',
        model: 'mock-haiku',
        taskRouting: { enabled: true },
      }),
    );
    process.env.HARNESS_HOME = home;
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    MockProvider.toolUseScript = [
      // Delegator turn 1: dispatch to cheap-task
      { kind: 'tool_use', name: 'AgentTool', input: { subagent_type: 'cheap-task', prompt: 'what is a dog?' }, id: 'call-1' },
      // Delegator turn 2: relay the result
      { kind: 'text', text: 'A dog is a domesticated mammal.' },
      // cheap-task atom turn 1: provide the answer
      { kind: 'text', text: 'A dog is a domesticated mammal.' },
    ];
  });
  afterEach(async () => {
    MockProvider.toolUseScript = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  test('trivial turn produces one cheap-task atom and relays the result', async () => {
    const { buildRuntime } = await import('../../src/server/runtime.js');
    const runtime = await buildRuntime({
      harnessHome: home,
      cwd: process.cwd(),
      cronEnabled: false,
    });
    // Drive a single turn through the runtime's query loop with prompt
    // "what is a dog?". Capture the final assistant message text.
    // Assert it contains "domesticated mammal".
    // Assert child sessions exist for both delegator AND cheap-task (via
    // sessionDb.listSessions or by inspecting toolUseScript consumption).
    await runtime.dispose();
  });
});
```

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement**

The implementer iterates on the test to find the right driver pattern. Look at `tests/agents/delegator.integration.test.ts` Phase 18 references for the runtime+query pattern.

- [ ] **Step 4: GREEN.**

- [ ] **Step 5: Commit**

```bash
git add tests/agents/delegator.integration.test.ts
git commit -m "test(router): integration test for trivial-turn smart routing"
```

---

### T14 — Integration test: compound turn → multi-atom + synthesis (~30 min · Opus)

**Files:**
- Extend: `tests/agents/delegator.integration.test.ts`.

- [ ] **Step 1: Write failing test**

Multi-atom scenario: delegator dispatches 3 atoms (cheap-task, moderate-task, frontier-task synthesis). Pre-load `MockProvider.toolUseScript` with the entire sequence (delegator turns + each atom's single turn).

```typescript
test('compound turn produces multi-atom + synthesis sequence', async () => {
  MockProvider.toolUseScript = [
    // Delegator turn 1: dispatch atom 1 (cheap-task)
    { kind: 'tool_use', name: 'AgentTool', input: { subagent_type: 'cheap-task', prompt: 'list X' }, id: 'a1' },
    // Delegator turn 2: dispatch atom 2 (moderate-task)
    { kind: 'tool_use', name: 'AgentTool', input: { subagent_type: 'moderate-task', prompt: 'analyze Y' }, id: 'a2' },
    // Delegator turn 3: dispatch synthesis atom (frontier-task)
    { kind: 'tool_use', name: 'AgentTool', input: { subagent_type: 'frontier-task', prompt: 'synthesize Atom 1 output: ...' }, id: 'a3' },
    // Delegator turn 4: relay final synthesis
    { kind: 'text', text: 'Final synthesized report.' },
    // cheap-task atom: respond
    { kind: 'text', text: 'List of X items.' },
    // moderate-task atom: respond
    { kind: 'text', text: 'Analysis of Y.' },
    // frontier-task atom: respond
    { kind: 'text', text: 'Final synthesized report.' },
  ];
  // Drive a turn through the runtime; assert final response contains
  // "Final synthesized report" and all three subagents were invoked.
});
```

- [ ] **Step 2-4: RED → implement → GREEN.**

- [ ] **Step 5: Commit**

```bash
git add tests/agents/delegator.integration.test.ts
git commit -m "test(router): integration test for compound-turn smart routing with synthesis"
```

---

### T15 — Integration tests: atom failure + atom timeout (~20 min)

**Files:**
- Create: `tests/router/atomFailure.test.ts`, `tests/router/atomTimeout.test.ts`.

- [ ] **Step 1: Write failing test (failure)**

```typescript
// tests/router/atomFailure.test.ts
test('atom failure: delegator continues to synthesis with failed-atom annotation', async () => {
  // MockProvider script: delegator dispatches 2 atoms.
  // Atom 1 throws (MockProvider.throwOnNext on cheap-task's turn).
  // Atom 2 succeeds (synthesis).
  // Assert the synthesis prompt that the frontier-task receives includes
  // 'Atom 1 (failed: ...)' in its input.
});
```

- [ ] **Step 2: Write failing test (timeout)**

```typescript
// tests/router/atomTimeout.test.ts
test('lane timeoutMs causes atom to be cancelled', async () => {
  // Configure taskRouting.lanes.cheap-task.timeoutMs=50.
  // MockProvider slowMode=true, slowModeDelayMs=200.
  // Drive a trivial turn; assert the cheap-task atom returns interrupted/timeout
  // and synthesis acknowledges the gap.
});
```

Note: lane timeoutMs enforcement requires plumbing via the scheduler's `perChildTimeoutMsOverride` per the R-D mitigation. If T7 didn't add this, add it here as part of T15:
- `SubagentScheduler.delegate()` accepts `perChildTimeoutMsOverride` on input.
- `AgentTool.call` resolves the override by looking up the target agent's role via `ctx.laneRegistry?.lookup(role)?.timeoutMs` and passes it to `scheduler.delegate()`.

- [ ] **Step 3-5: RED → implement → GREEN → commit**

```bash
git add tests/router/atomFailure.test.ts tests/router/atomTimeout.test.ts \
  src/runtime/scheduler.ts src/tools/AgentTool.ts
git commit -m "test(router): atom failure + timeout integration tests; lane timeoutMs override"
```

---

### T16 — Semantic test suite (~20 min)

**Files:**
- Create: `tests/semantic/suites/22-task-routing.cases.ts`.

- [ ] **Step 1: Read `tests/semantic/framework/types.ts` to confirm the SemanticTest shape.**

- [ ] **Step 2: Create the case file with 5 cases per the spec**

```typescript
// tests/semantic/suites/22-task-routing.cases.ts
import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'task-routing-trivial',
    name: 'Trivial turn → one cheap-task atom',
    description: 'Smart router on; trivial question should dispatch a single cheap-task atom.',
    category: 'workflow',
    prompt: 'what is a dog?',
    setup: {
      userConfig: { taskRouting: { enabled: true } },
    },
    judgeCriteria: {
      mustSatisfy: [
        'the transcript shows exactly one delegator invocation',
        'the delegator dispatched exactly one cheap-task atom',
        'the final response mentions that a dog is a domesticated mammal or similar',
      ],
    },
    timeoutMs: 60_000,
  },
  {
    id: 'task-routing-lookup',
    name: 'Lookup turn → one or two atoms',
    description: 'Smart router on; file-lookup task should dispatch one or two atoms on cheap or moderate lanes.',
    category: 'workflow',
    prompt: 'find files in src/ that mention AgentTool',
    setup: {
      userConfig: { taskRouting: { enabled: true } },
    },
    judgeCriteria: {
      mustSatisfy: [
        'the transcript shows delegator delegation to a cheap-task or moderate-task atom',
        'the final response lists files containing AgentTool',
      ],
      shouldNot: ['frontier-task was unnecessarily invoked'],
    },
    timeoutMs: 90_000,
  },
  {
    id: 'task-routing-compound',
    name: 'Compound turn → multi-atom + synthesis',
    description: 'Compound task should decompose into multiple atoms plus a synthesis atom.',
    category: 'workflow',
    prompt: 'summarize what this project does based on the README and src/ directory structure',
    setup: {
      userConfig: { taskRouting: { enabled: true } },
    },
    judgeCriteria: {
      mustSatisfy: [
        'the delegator dispatched at least two atoms before producing the final response',
        'at least one frontier-task atom OR moderate-task synthesis atom was used',
        'the final response is a coherent project summary',
      ],
    },
    timeoutMs: 180_000,
  },
  {
    id: 'task-routing-hard-reasoning',
    name: 'Hard reasoning → at least one frontier-task atom',
    description: 'Hard reasoning task should route to frontier-task.',
    category: 'workflow',
    prompt: 'design a permission model for an OAuth-only multi-tenant SaaS application',
    setup: {
      userConfig: { taskRouting: { enabled: true } },
    },
    judgeCriteria: {
      mustSatisfy: [
        'at least one frontier-task atom was invoked',
        'the final response describes a coherent permission model with multiple components',
      ],
    },
    timeoutMs: 120_000,
  },
  {
    id: 'task-routing-failure-recovery',
    name: 'Atom failure surfaces honestly in the synthesis',
    description: 'When a configured lane is unreachable, the response acknowledges the failure.',
    category: 'workflow',
    prompt: 'what files are in src/',
    setup: {
      userConfig: {
        taskRouting: {
          enabled: true,
          lanes: {
            'cheap-task': { provider: 'ollama', model: 'definitely-not-installed-model' },
          },
        },
      },
    },
    judgeCriteria: {
      mustSatisfy: [
        'the response acknowledges that the task could not be fully completed',
        'the response does NOT fabricate a fake file listing',
      ],
    },
    timeoutMs: 60_000,
  },
];
```

- [ ] **Step 3: Run only the unit/integration suite (not semantic) to confirm green**

Run: `bun run lint && bun run typecheck && bun run test`

(Semantic tests run separately via `bun run test:semantic` and are a manual smoke for now.)

- [ ] **Step 4: Commit**

```bash
git add tests/semantic/suites/22-task-routing.cases.ts
git commit -m "test(semantic): add task-routing suite"
```

---

### T17 — Documentation: usage.md + state pointer (~15 min · Sonnet eligible)

**Files:**
- Modify: `docs/03-cli-reference/usage.md`.
- Create: `docs/07-history/state/2026-05-23-phase-1-task-routing.md`.
- Modify: `CLAUDE.md`, `AGENTS.md` (byte-identical mirror).

- [ ] **Step 1: Add `docs/03-cli-reference/usage.md` section**

Append a new section titled "Multi-provider task routing (Phase 1)" covering:
- Config block with defaults
- Disabled vs enabled behavior
- The three modes (trivial / compound / synthesis-only)
- Per-lane override examples (including ollama+anthropic mixed config)
- `SOV_TASK_ROUTING_ENABLED=1` env override
- The boot-time preflight error format

- [ ] **Step 2: Create `docs/07-history/state/2026-05-23-phase-1-task-routing.md`**

Mirror the structure of `docs/07-history/state/2026-05-22-phase-17-cron.md`. Sections:
- HEAD (filled in by close-out commit)
- Chain since prior close-out
- Suite numbers
- Phase status
- Where we are
- What shipped
- Behavioral notes worth knowing next session
- Open follow-ups (Phase 2 + Phase 3 sketches)
- Postmortem-rule compliance

- [ ] **Step 3: Update CLAUDE.md + AGENTS.md state pointer**

In the "Session boot" section's "most recent close-out snapshot" line, update from `docs/07-history/state/2026-05-23-phase-18-openai-api-server.md` to `docs/07-history/state/2026-05-23-phase-1-task-routing.md`. Add a new row at the top of the "Current state" table.

After editing CLAUDE.md, copy to AGENTS.md to keep them byte-identical:

```bash
cp CLAUDE.md AGENTS.md
diff CLAUDE.md AGENTS.md && echo IDENTICAL
```

- [ ] **Step 4: Commit**

```bash
git add docs/03-cli-reference/usage.md docs/07-history/state/2026-05-23-phase-1-task-routing.md CLAUDE.md AGENTS.md
git commit -m "docs: Phase 1 task routing usage + state snapshot"
```

---

### T18 — Testing log entry + manual smoke (~15 min)

**Files:**
- Modify: `docs/06-testing/testing-log.md`.

- [ ] **Step 1: Run the full gate one final time**

```bash
bun run lint && bun run typecheck && bun run test
```

Capture pass/fail counts. Expected: 2192 baseline + new tests (~25-30 added across T1-T16) ≈ 2215-2225 pass / 0 fail / 14 skip.

- [ ] **Step 2: Manual smoke (if real Anthropic API key is available)**

```bash
~/.sov/bin/sov upgrade  # if v0.4.1 is already cut; else build via T19
sov config set taskRouting.enabled true
echo "what is a dog" | sov drive --headless --once 2>&1 | tail -20
sov config set taskRouting.enabled false
```

Capture observable behavior. If no real key, document as "skipped due to no provider credentials in env" and run T19 to ship the binary so the smoke can happen offline later.

- [ ] **Step 3: Append `docs/06-testing/testing-log.md`**

```markdown
## 2026-05-23 — Phase 1 multi-provider task routing

**Scope:** Phase 1 of the multi-provider task routing feature shipped per the spec at `specs/2026-05-23-multi-provider-task-routing-design.md`. New `taskRouting` config block (disabled by default); new agents (`delegator`, `cheap-task`, `moderate-task`, `frontier-task`); B-via-D bridge mention in parent system prompt (applies in disabled mode too); smart-router system prompt segment injected when enabled; boot-time lane preflight; scheduler `resolveLane` callback; `inheritParentTools` + `allowedSubagents` agent fields; `AgentTool` recursion guard.

**Commands:**
\`\`\`
bun run lint && bun run typecheck && bun run test
# <pass-count> pass / 0 fail / 14 skip
\`\`\`

**Manual smoke:** <results or "deferred">

**Follow-ups:** Phase 2 (rich observability + escalation) per spec.
```

- [ ] **Step 4: Commit**

```bash
git add docs/06-testing/testing-log.md
git commit -m "docs(testing-log): record Phase 1 task routing verification"
```

---

### T19 — Cut binary release v0.4.1 (~5 min · Sonnet eligible)

**Files:**
- Modify: `package.json`.

- [ ] **Step 1: Bump version**

Read `package.json`; confirm current version is `0.4.0`. Bump to `0.4.1`.

- [ ] **Step 2: Commit + push**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore(release): bump version 0.4.0 -> 0.4.1

Phase 1 — Multi-provider task routing ships:

- New taskRouting config block (disabled by default).
- New sub-agents: delegator, cheap-task, moderate-task, frontier-task.
- B-via-D bridge baseline: parent system prompt mentions cost-lane
  agents even when smart router is off.
- When taskRouting.enabled=true: parent's first action per turn is
  AgentTool(delegator, prompt). Delegator decomposes or single-shots
  and dispatches atoms via AgentTool to cost-lane sub-agents.
- Synthesis is the final atom; lane chosen dynamically.
- AgentTool recursion guard via allowedSubagents field.
- Tool pool inheritance via inheritParentTools field.
- Lane resolution via scheduler resolveLane callback.
- Boot-time lane preflight (fail-fast on misconfigured lanes).

Suite: ~2215-2225 pass / 0 fail / 14 skip.
EOF
)"
git push origin master
```

- [ ] **Step 3: Build + release**

```bash
unset GH_TOKEN
SOV_RELEASES_PATH=/Users/julie/code/sov-releases bun run release v0.4.1
```

- [ ] **Step 4: Smoke**

```bash
~/.sov/bin/sov upgrade
~/.sov/bin/sov --version  # expect 0.4.1
```

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| D1-D13 locked decisions | T1 (D1, D6, D12, D13), T5/T7/T8 (D7), T10/T11/T12 (D4, D8, D12), T6 (D2), T9 (D13) |
| Phase 1 file structure | T1-T18 cover create/modify list |
| Mode 1 disabled state | T6 (parent prompt addition) |
| Mode 2 trivial turn | T13 |
| Mode 3 compound turn | T14 |
| Edge case: multi-turn context | T11 (smart-router prompt mentions conversation_context) |
| Edge case: AgentTool recursion | T5, T7, T8 |
| Edge case: atom failure | T15 |
| Configuration surface | T1, T17 (docs) |
| Error handling: boot preflight | T4, T9 |
| Error handling: atom transport / timeout | T15 |
| Error handling: synthesis as failure surface | T10 (delegator prompt + frontier-task prompt) |
| Unit tests | T1-T8 |
| Integration tests | T13, T14, T15 |
| Semantic tests | T16 |
| Soak metrics | Deferred to Phase 2 (use existing sub-agent session traces in v1) |
| DoD manual smoke | T18 |

**Placeholder scan:** no "TBD", "TODO", or vague "add appropriate error handling" — all steps show concrete code or commands.

**Type consistency:** `LaneConfig`, `TaskRoutingConfig`, `LaneRegistry`, `resolveLane`, `buildLaneRegistry`, `runLanePreflight`, `LanePreflightError`, `buildSubagentExclusions`, `AgentDefinition.inheritParentTools`, `AgentDefinition.allowedSubagents`, `ToolContext.parentAgentName`, `MockProvider.toolUseScript`, `ToolCallScript`, `BuildSystemSegmentsOptions.smartRouterPrompt`, `Runtime.laneRegistry` — names consistent across T1-T19.

---

## Execution

Plan ready. **REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`.** Each task is a single subagent dispatch (Opus 4.7 default; Sonnet 4.6 for the trivially mechanical tasks flagged). The user has authorized autonomous execution per the message preceding this plan.

After T19 (release), the session ends. Phase 1 ships. Phase 2 + Phase 3 specs are sketched in the design doc; their plans get written after Phase 1 soak data is collected.
