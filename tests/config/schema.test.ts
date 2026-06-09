// Direct validation tests for SettingsSchema. The store-level tests
// (config/store.test.ts) cover read/write/dot-path behavior; this
// file pins the schema's strict-mode behavior, enum coverage, and
// numeric bounds. Catches breakage from schema edits or accidental
// non-strict relaxations.

import { describe, expect, test } from 'bun:test';
import { SettingsSchema } from '../../src/config/schema.js';

describe('SettingsSchema — strict mode', () => {
  test('rejects unknown top-level keys', () => {
    expect(() => SettingsSchema.parse({ unknownField: 'x' })).toThrow();
  });

  test('rejects unknown nested keys under providers.<name>', () => {
    expect(() =>
      SettingsSchema.parse({
        providers: { anthropic: { unknown: 'x' } },
      }),
    ).toThrow();
  });

  test('rejects unknown nested keys under ui', () => {
    expect(() => SettingsSchema.parse({ ui: { unknown: true } })).toThrow();
  });

  test('rejects unknown nested keys under microcompaction', () => {
    expect(() => SettingsSchema.parse({ microcompaction: { unknown: 1 } })).toThrow();
  });

  test('rejects unknown nested keys under compaction', () => {
    expect(() => SettingsSchema.parse({ compaction: { unknown: 1 } })).toThrow();
  });

  test('empty object is valid (every field optional)', () => {
    expect(SettingsSchema.parse({})).toEqual({});
  });

  test('top-level `theme` accepts arbitrary string (M9.5 Go-TUI writeback)', () => {
    // Regression: M9.5 T3 Go-TUI theme persistence writes a top-level
    // `theme` field. Before this field was added to SettingsSchema, any
    // developer who switched themes via /theme in the Go TUI would have
    // their TS-side sov invocation throw a ZodError on every read.
    for (const themeName of ['dark', 'light', 'tokyo-night', 'sovereign', 'my-custom-toml']) {
      expect(() => SettingsSchema.parse({ theme: themeName })).not.toThrow();
    }
    expect(() => SettingsSchema.parse({ theme: 123 })).toThrow();
  });

  test('config with both top-level `theme` and nested `ui.theme` parses cleanly', () => {
    // The Go TUI writes top-level `theme`; legacy configs may also carry
    // `ui.theme`. Both must coexist without schema error.
    const parsed = SettingsSchema.parse({
      theme: 'tokyo-night',
      ui: { theme: 'dark' },
    });
    expect(parsed.theme).toBe('tokyo-night');
    expect(parsed.ui?.theme).toBe('dark');
  });
});

describe('SettingsSchema — enum coverage', () => {
  test('permissionMode accepts default | ask | bypass', () => {
    for (const mode of ['default', 'ask', 'bypass']) {
      expect(() => SettingsSchema.parse({ permissionMode: mode })).not.toThrow();
    }
    expect(() => SettingsSchema.parse({ permissionMode: 'loud' })).toThrow();
  });

  test('ui.theme accepts dark | light | no-color', () => {
    for (const theme of ['dark', 'light', 'no-color']) {
      expect(() => SettingsSchema.parse({ ui: { theme } })).not.toThrow();
    }
    expect(() => SettingsSchema.parse({ ui: { theme: 'solarized' } })).toThrow();
  });

  test('ui.surface is no longer accepted (M13)', () => {
    expect(() => SettingsSchema.parse({ ui: { surface: 'tui' } })).toThrow();
    expect(() => SettingsSchema.parse({ ui: { surface: 'repl' } })).toThrow();
  });

  test('webSearch.provider accepts tavily | brave', () => {
    for (const provider of ['tavily', 'brave']) {
      expect(() => SettingsSchema.parse({ webSearch: { provider } })).not.toThrow();
    }
    expect(() => SettingsSchema.parse({ webSearch: { provider: 'google' } })).toThrow();
  });

  test('providers.<name>.strategy accepts ROUND_ROBIN | LEAST_USED | FILL_FIRST', () => {
    for (const strategy of ['ROUND_ROBIN', 'LEAST_USED', 'FILL_FIRST']) {
      expect(() => SettingsSchema.parse({ providers: { anthropic: { strategy } } })).not.toThrow();
    }
    expect(() =>
      SettingsSchema.parse({ providers: { anthropic: { strategy: 'RANDOM' } } }),
    ).toThrow();
  });
});

describe('SettingsSchema — numeric bounds', () => {
  test('maxTurns rejects zero / negative / non-integer', () => {
    expect(() => SettingsSchema.parse({ maxTurns: 0 })).toThrow();
    expect(() => SettingsSchema.parse({ maxTurns: -1 })).toThrow();
    expect(() => SettingsSchema.parse({ maxTurns: 1.5 })).toThrow();
    expect(() => SettingsSchema.parse({ maxTurns: 100 })).not.toThrow();
  });

  test('compaction.proactiveThresholdPct enforces 1..99 range', () => {
    expect(() => SettingsSchema.parse({ compaction: { proactiveThresholdPct: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ compaction: { proactiveThresholdPct: 100 } })).toThrow();
    expect(() => SettingsSchema.parse({ compaction: { proactiveThresholdPct: 50 } })).not.toThrow();
    expect(() => SettingsSchema.parse({ compaction: { proactiveThresholdPct: 99 } })).not.toThrow();
  });

  test('microcompaction.triggerThresholdPct accepts 0..100', () => {
    expect(() =>
      SettingsSchema.parse({ microcompaction: { triggerThresholdPct: 0 } }),
    ).not.toThrow();
    expect(() =>
      SettingsSchema.parse({ microcompaction: { triggerThresholdPct: 100 } }),
    ).not.toThrow();
    expect(() => SettingsSchema.parse({ microcompaction: { triggerThresholdPct: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ microcompaction: { triggerThresholdPct: 101 } })).toThrow();
  });

  test('microcompaction.keepRecent rejects zero / negative', () => {
    expect(() => SettingsSchema.parse({ microcompaction: { keepRecent: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ microcompaction: { keepRecent: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ microcompaction: { keepRecent: 5 } })).not.toThrow();
  });

  test('webSearch.maxResults enforces 1..20 range', () => {
    expect(() => SettingsSchema.parse({ webSearch: { maxResults: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ webSearch: { maxResults: 21 } })).toThrow();
    expect(() => SettingsSchema.parse({ webSearch: { maxResults: 1 } })).not.toThrow();
    expect(() => SettingsSchema.parse({ webSearch: { maxResults: 20 } })).not.toThrow();
  });

  test('ui.contextMeter.warnAtPercent and dangerAtPercent enforce 0..100', () => {
    expect(() => SettingsSchema.parse({ ui: { contextMeter: { warnAtPercent: -1 } } })).toThrow();
    expect(() => SettingsSchema.parse({ ui: { contextMeter: { warnAtPercent: 101 } } })).toThrow();
    expect(() =>
      SettingsSchema.parse({ ui: { contextMeter: { dangerAtPercent: 80 } } }),
    ).not.toThrow();
  });

  test('providers.<name>.numCtx requires positive integer', () => {
    expect(() => SettingsSchema.parse({ providers: { ollama: { numCtx: 0 } } })).toThrow();
    expect(() => SettingsSchema.parse({ providers: { ollama: { numCtx: -1 } } })).toThrow();
    expect(() => SettingsSchema.parse({ providers: { ollama: { numCtx: 1.5 } } })).toThrow();
    expect(() => SettingsSchema.parse({ providers: { ollama: { numCtx: 16384 } } })).not.toThrow();
  });
});

describe('SettingsSchema — wave-1 ui.* keys round-trip', () => {
  test('ui.footer.enabled', () => {
    const parsed = SettingsSchema.parse({ ui: { footer: { enabled: false } } });
    expect(parsed.ui?.footer?.enabled).toBe(false);
  });

  test('ui.diffRender.enabled', () => {
    const parsed = SettingsSchema.parse({ ui: { diffRender: { enabled: true } } });
    expect(parsed.ui?.diffRender?.enabled).toBe(true);
  });

  test('combined ui.* configuration round-trips', () => {
    const input = {
      ui: {
        theme: 'light' as const,
        footer: { enabled: true },
        contextMeter: { warnAtPercent: 70, dangerAtPercent: 90 },
        diffRender: { enabled: true },
      },
    };
    expect(SettingsSchema.parse(input)).toEqual(input);
  });

  // ux-fixes 2026-05-22: extend ui.toolOutput with a `mode` enum that
  // controls compact (default, one-liner per tool call) vs detailed
  // (bordered card with output capped to inlineLines). Spec:
  // docs/specs/2026-05-22-tui-tool-call-abstraction-design.md
  test('ui.toolOutput.mode accepts compact', () => {
    const parsed = SettingsSchema.parse({ ui: { toolOutput: { mode: 'compact' } } });
    expect(parsed.ui?.toolOutput?.mode).toBe('compact');
  });

  test('ui.toolOutput.mode accepts detailed', () => {
    const parsed = SettingsSchema.parse({ ui: { toolOutput: { mode: 'detailed' } } });
    expect(parsed.ui?.toolOutput?.mode).toBe('detailed');
  });

  test('ui.toolOutput.mode rejects unknown values', () => {
    expect(() => SettingsSchema.parse({ ui: { toolOutput: { mode: 'fancy' } } })).toThrow();
  });

  test('ui.toolOutput.mode + inlineLines coexist', () => {
    const input = {
      ui: { toolOutput: { mode: 'detailed' as const, inlineLines: 25 } },
    };
    expect(SettingsSchema.parse(input)).toEqual(input);
  });

  test('ui.toolOutput.inlineLines still validates 0..200', () => {
    expect(() => SettingsSchema.parse({ ui: { toolOutput: { inlineLines: -1 } } })).toThrow();
    expect(() => SettingsSchema.parse({ ui: { toolOutput: { inlineLines: 201 } } })).toThrow();
    expect(() => SettingsSchema.parse({ ui: { toolOutput: { inlineLines: 200 } } })).not.toThrow();
  });
});

describe('SettingsSchema — providers config shape', () => {
  test('credentials list accepts shape with id/apiKey/priority', () => {
    const parsed = SettingsSchema.parse({
      providers: {
        anthropic: {
          credentials: [
            { id: 'primary', apiKey: 'sk-x', priority: 1 },
            { id: 'fallback', apiKey: 'sk-y' },
          ],
        },
      },
    });
    expect(parsed.providers?.anthropic?.credentials?.length).toBe(2);
  });

  test('apiKeys array round-trips', () => {
    const parsed = SettingsSchema.parse({
      providers: { openrouter: { apiKeys: ['k1', 'k2'] } },
    });
    expect(parsed.providers?.openrouter?.apiKeys).toEqual(['k1', 'k2']);
  });

  test('baseUrl rejects non-URL strings', () => {
    expect(() =>
      SettingsSchema.parse({ providers: { ollama: { baseUrl: 'not-a-url' } } }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({ providers: { ollama: { baseUrl: 'http://localhost:11434' } } }),
    ).not.toThrow();
  });

  // sov is the keyless local lane (the Sovereign L1 engine). Its config block
  // reuses ProviderConfigSchema, so a baseUrl/model override round-trips and
  // unknown keys are still rejected under strict mode.
  test('providers.sov accepts model + baseUrl overrides', () => {
    const parsed = SettingsSchema.parse({
      providers: {
        sov: { model: 'mlx-community/Qwen3-4B-4bit', baseUrl: 'http://127.0.0.1:8000/v1' },
      },
    });
    expect(parsed.providers?.sov?.model).toBe('mlx-community/Qwen3-4B-4bit');
    expect(parsed.providers?.sov?.baseUrl).toBe('http://127.0.0.1:8000/v1');
  });

  test('providers.sov is optional / absent by default', () => {
    expect(SettingsSchema.parse({ providers: {} }).providers?.sov).toBeUndefined();
  });

  test('rejects unknown keys under providers.sov (strict mode)', () => {
    expect(() => SettingsSchema.parse({ providers: { sov: { unknown: 'x' } } })).toThrow();
  });
});

describe('SettingsSchema — debugMode', () => {
  test('umbrella + per-capability flags coexist', () => {
    const parsed = SettingsSchema.parse({
      debugMode: { enabled: true, transcript: true, transcriptDir: '/tmp/x' },
    });
    expect(parsed.debugMode?.enabled).toBe(true);
    expect(parsed.debugMode?.transcript).toBe(true);
  });

  test('rejects unknown debugMode keys', () => {
    expect(() => SettingsSchema.parse({ debugMode: { unknown: true } })).toThrow();
  });
});

describe('SettingsSchema — behavior block', () => {
  test('accepts behavior.maxToolCallsBeforeCheckin as a positive integer', () => {
    expect(() =>
      SettingsSchema.parse({ behavior: { maxToolCallsBeforeCheckin: 10 } }),
    ).not.toThrow();
  });

  test('rejects behavior.maxToolCallsBeforeCheckin = 0 (must be positive)', () => {
    expect(() => SettingsSchema.parse({ behavior: { maxToolCallsBeforeCheckin: 0 } })).toThrow();
  });

  test('rejects unknown keys under behavior (strict mode)', () => {
    expect(() => SettingsSchema.parse({ behavior: { unknownField: true } })).toThrow();
  });
});

// Phase 1 T1 — taskRouting schema.
// The taskRouting block configures the smart-router delegator + cost-lane
// sub-agents (cheap-task / moderate-task / frontier-task). Pure config
// schema; no behavior change at this layer.
// Plan: docs/plans/2026-05-23-phase-1-task-routing.md
describe('taskRouting schema', () => {
  test('accepts a full override', () => {
    const parsed = SettingsSchema.parse({
      taskRouting: {
        enabled: true,
        delegator: { model: 'claude-sonnet-4-6' },
        lanes: {
          'cheap-task': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
          'moderate-task': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          'frontier-task': { provider: 'anthropic', model: 'claude-opus-4-7' },
        },
      },
    });
    expect(parsed.taskRouting?.enabled).toBe(true);
    expect(parsed.taskRouting?.lanes?.['cheap-task']?.provider).toBe('anthropic');
  });

  test('empty taskRouting applies defaults', () => {
    const parsed = SettingsSchema.parse({ taskRouting: {} });
    expect(parsed.taskRouting?.enabled).toBe(false);
    expect(parsed.taskRouting?.delegator?.model).toBe('claude-sonnet-4-6');
  });

  test('rejects negative timeoutMs', () => {
    expect(() =>
      SettingsSchema.parse({
        taskRouting: {
          lanes: { 'cheap-task': { provider: 'anthropic', model: 'haiku', timeoutMs: -1 } },
        },
      }),
    ).toThrow();
  });

  test('omitting taskRouting entirely is fine', () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.taskRouting).toBeUndefined();
  });
});

// subscriptionExecutor and taskRouting are two CONFLICTING cost strategies on
// the same delegation path — a flat-rate subscription (offload to `claude -p`)
// vs. API cost-tier routing (parent → delegator → cost-lanes). The delegator
// can't even reach the subscription-executor role, and the ToS postures are
// opposite. Enabling both is incoherent, so a top-level superRefine rejects it.
describe('subscriptionExecutor × taskRouting mutual exclusion', () => {
  const MUTEX_MESSAGE = 'subscriptionExecutor` and `taskRouting` are mutually exclusive';

  test('both enabled → parse throws with the mutual-exclusion message', () => {
    expect(() =>
      SettingsSchema.parse({
        subscriptionExecutor: { enabled: true },
        taskRouting: { enabled: true },
      }),
    ).toThrow(MUTEX_MESSAGE);
  });

  test('only subscriptionExecutor enabled → ok (the live dogfood config)', () => {
    const parsed = SettingsSchema.parse({
      subscriptionExecutor: { enabled: true },
      taskRouting: { enabled: false },
    });
    expect(parsed.subscriptionExecutor?.enabled).toBe(true);
    expect(parsed.taskRouting?.enabled).toBe(false);
  });

  test('only subscriptionExecutor enabled, taskRouting absent → ok', () => {
    const parsed = SettingsSchema.parse({ subscriptionExecutor: { enabled: true } });
    expect(parsed.subscriptionExecutor?.enabled).toBe(true);
    expect(parsed.taskRouting).toBeUndefined();
  });

  test('only taskRouting enabled → ok', () => {
    const parsed = SettingsSchema.parse({
      taskRouting: { enabled: true },
      subscriptionExecutor: { enabled: false },
    });
    expect(parsed.taskRouting?.enabled).toBe(true);
    expect(parsed.subscriptionExecutor?.enabled).toBe(false);
  });

  test('only taskRouting enabled, subscriptionExecutor absent → ok', () => {
    const parsed = SettingsSchema.parse({ taskRouting: { enabled: true } });
    expect(parsed.taskRouting?.enabled).toBe(true);
    expect(parsed.subscriptionExecutor).toBeUndefined();
  });

  test('neither enabled (both present, both false) → ok', () => {
    const parsed = SettingsSchema.parse({
      subscriptionExecutor: { enabled: false },
      taskRouting: { enabled: false },
    });
    expect(parsed.subscriptionExecutor?.enabled).toBe(false);
    expect(parsed.taskRouting?.enabled).toBe(false);
  });

  test('both blocks absent → ok', () => {
    expect(() => SettingsSchema.parse({})).not.toThrow();
  });

  test('taskRouting present but enabled omitted (defaults false) + subscriptionExecutor on → ok', () => {
    // taskRouting.enabled defaults to false, so a bare `taskRouting: {}` must
    // NOT trip the mutex when subscriptionExecutor is enabled.
    const parsed = SettingsSchema.parse({
      subscriptionExecutor: { enabled: true },
      taskRouting: {},
    });
    expect(parsed.subscriptionExecutor?.enabled).toBe(true);
    expect(parsed.taskRouting?.enabled).toBe(false);
  });
});

// Learning-loop spike Phase 1 Task 10 — learning.recall schema.
// The recall block gates the per-session recall thunk that splices
// recalled instinct lessons in front of the latest user turn. ON by
// default as of v0.6.16 (founder decision 2026-06-04, post-Q1); explicit
// `enabled: false` still opts out. Pure config schema.
// Plan: docs/plans/2026-06-03-learning-loop-spike-kickoff.md
describe('learning.recall schema', () => {
  test('defaults: recall enabled when the recall block is present', () => {
    // The `.default(true)` fires whenever a `recall` object is parsed. (When
    // the block is ABSENT, Zod has nothing to default and leaves it
    // undefined; the runtime gate in src/server/sessionContext.ts treats
    // undefined as ON — `recallCfg?.enabled !== false` — so absent config
    // is also recall-ON. That absent-config path is covered there, not here.)
    const parsed = SettingsSchema.parse({ learning: { recall: {} } });
    expect(parsed.learning?.recall?.enabled).toBe(true);
  });

  test('accepts a recall override (explicit enable)', () => {
    const parsed = SettingsSchema.parse({
      learning: { recall: { enabled: true, maxLessons: 5, tokenBudget: 800 } },
    });
    expect(parsed.learning?.recall?.enabled).toBe(true);
    expect(parsed.learning?.recall?.maxLessons).toBe(5);
    expect(parsed.learning?.recall?.tokenBudget).toBe(800);
  });

  test('accepts a recall override (explicit disable still parses to false)', () => {
    const parsed = SettingsSchema.parse({ learning: { recall: { enabled: false } } });
    expect(parsed.learning?.recall?.enabled).toBe(false);
  });

  test('recall sub-object applies its own field defaults when present but partial', () => {
    const parsed = SettingsSchema.parse({ learning: { recall: { enabled: true } } });
    expect(parsed.learning?.recall?.enabled).toBe(true);
    expect(parsed.learning?.recall?.maxLessons).toBe(8);
    expect(parsed.learning?.recall?.tokenBudget).toBe(1200);
  });

  test('rejects non-positive maxLessons / tokenBudget', () => {
    expect(() => SettingsSchema.parse({ learning: { recall: { maxLessons: 0 } } })).toThrow();
    expect(() => SettingsSchema.parse({ learning: { recall: { tokenBudget: -1 } } })).toThrow();
  });

  test('rejects unknown keys under learning.recall (strict mode)', () => {
    expect(() => SettingsSchema.parse({ learning: { recall: { unknownField: true } } })).toThrow();
  });
});

describe('gateway schema', () => {
  test('accepts a full gateway block', () => {
    const p = SettingsSchema.parse({
      gateway: {
        host: '0.0.0.0',
        port: 8766,
        token: 'secret',
        corsOrigins: ['https://app.example'],
      },
    });
    expect(p.gateway?.host).toBe('0.0.0.0');
    expect(p.gateway?.port).toBe(8766);
    expect(p.gateway?.token).toBe('secret');
    expect(p.gateway?.corsOrigins).toEqual(['https://app.example']);
  });

  test('gateway is optional / absent by default', () => {
    expect(SettingsSchema.parse({}).gateway).toBeUndefined();
  });

  test('rejects unknown keys in gateway (strict)', () => {
    expect(() => SettingsSchema.parse({ gateway: { bogus: 1 } })).toThrow();
  });

  // Phase B T2 — gateway.eventBufferSize sets the per-session SSE replay
  // ring size for buses created at runtime. Pure config schema here.
  // Plan: docs/plans/2026-06-?? phase-b-multi-client-transport.
  test('accepts gateway.eventBufferSize as a positive integer', () => {
    const p = SettingsSchema.parse({ gateway: { eventBufferSize: 256 } });
    expect(p.gateway?.eventBufferSize).toBe(256);
  });

  test('gateway.eventBufferSize is absent / undefined by default', () => {
    expect(SettingsSchema.parse({ gateway: {} }).gateway?.eventBufferSize).toBeUndefined();
    expect(SettingsSchema.parse({}).gateway?.eventBufferSize).toBeUndefined();
  });

  test('rejects non-positive / non-integer gateway.eventBufferSize', () => {
    expect(() => SettingsSchema.parse({ gateway: { eventBufferSize: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ gateway: { eventBufferSize: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ gateway: { eventBufferSize: 1.5 } })).toThrow();
  });

  // Phase D T5 — gateway idle-session lifecycle policy fields consumed by the
  // SessionSupervisor: idleSessionTimeoutMs / idleSweepIntervalMs (positive int
  // ms) + maxConcurrentSessions (non-negative int; 0 = unlimited). All optional.
  test('accepts gateway idle/sweep/max fields', () => {
    const p = SettingsSchema.parse({
      gateway: {
        idleSessionTimeoutMs: 60000,
        idleSweepIntervalMs: 30000,
        maxConcurrentSessions: 5,
      },
    });
    expect(p.gateway?.idleSessionTimeoutMs).toBe(60000);
    expect(p.gateway?.idleSweepIntervalMs).toBe(30000);
    expect(p.gateway?.maxConcurrentSessions).toBe(5);
  });

  test('gateway idle/sweep/max fields are absent / undefined by default', () => {
    const p = SettingsSchema.parse({ gateway: {} });
    expect(p.gateway?.idleSessionTimeoutMs).toBeUndefined();
    expect(p.gateway?.idleSweepIntervalMs).toBeUndefined();
    expect(p.gateway?.maxConcurrentSessions).toBeUndefined();
    // Absent gateway block stays valid too.
    expect(SettingsSchema.parse({}).gateway).toBeUndefined();
  });

  test('rejects non-positive / non-integer idleSessionTimeoutMs', () => {
    expect(() => SettingsSchema.parse({ gateway: { idleSessionTimeoutMs: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ gateway: { idleSessionTimeoutMs: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ gateway: { idleSessionTimeoutMs: 1.5 } })).toThrow();
  });

  test('rejects non-positive / non-integer idleSweepIntervalMs', () => {
    expect(() => SettingsSchema.parse({ gateway: { idleSweepIntervalMs: 0 } })).toThrow();
    expect(() => SettingsSchema.parse({ gateway: { idleSweepIntervalMs: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ gateway: { idleSweepIntervalMs: 1.5 } })).toThrow();
  });

  test('maxConcurrentSessions accepts 0 (unlimited) but rejects negatives / non-integers', () => {
    expect(
      SettingsSchema.parse({ gateway: { maxConcurrentSessions: 0 } }).gateway
        ?.maxConcurrentSessions,
    ).toBe(0);
    expect(() => SettingsSchema.parse({ gateway: { maxConcurrentSessions: -1 } })).toThrow();
    expect(() => SettingsSchema.parse({ gateway: { maxConcurrentSessions: 1.5 } })).toThrow();
  });
});

// Phase E T1 — gateway.principals registry: a multi-user named-principal list,
// each with a unique id (filesystem-safe, ^[A-Za-z0-9_-]+$) + a non-empty
// bearer token (unique) + optional display name. Mutually exclusive with the
// single-token gateway.token (one auth model at a time).
describe('SettingsSchema — gateway.principals', () => {
  test('accepts a valid principals list', () => {
    const p = SettingsSchema.parse({
      gateway: {
        principals: [
          { id: 'alice', token: 'tok-a' },
          { id: 'bob', token: 'tok-b', name: 'Bob' },
        ],
      },
    });
    expect(p.gateway?.principals).toEqual([
      { id: 'alice', token: 'tok-a' },
      { id: 'bob', token: 'tok-b', name: 'Bob' },
    ]);
  });

  test('absent principals stays valid', () => {
    expect(SettingsSchema.parse({ gateway: {} }).gateway?.principals).toBeUndefined();
    expect(SettingsSchema.parse({}).gateway?.principals).toBeUndefined();
  });

  test('token-only (no principals) stays valid', () => {
    expect(SettingsSchema.parse({ gateway: { token: 'secret' } }).gateway?.token).toBe('secret');
  });

  // Fix E2 — an operator who sets `principals: []` (intending to fill it)
  // would otherwise silently degrade to single-user/open on loopback. Reject
  // an explicitly-present-but-empty array with an actionable message.
  test('rejects an empty principals array', () => {
    expect(() => SettingsSchema.parse({ gateway: { principals: [] } })).toThrow(
      /gateway\.principals must not be empty when set/,
    );
  });

  test('a single-entry principals array still parses', () => {
    const p = SettingsSchema.parse({ gateway: { principals: [{ id: 'alice', token: 'tok-a' }] } });
    expect(p.gateway?.principals).toHaveLength(1);
  });

  test('rejects principals AND token both set (mutually exclusive)', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: { token: 'secret', principals: [{ id: 'alice', token: 'tok-a' }] },
      }),
    ).toThrow();
  });

  test('rejects duplicate principal ids', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals: [
            { id: 'alice', token: 'tok-a' },
            { id: 'alice', token: 'tok-b' },
          ],
        },
      }),
    ).toThrow();
  });

  test('rejects duplicate principal tokens', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals: [
            { id: 'alice', token: 'tok-same' },
            { id: 'bob', token: 'tok-same' },
          ],
        },
      }),
    ).toThrow();
  });

  test('rejects an id that is not ^[A-Za-z0-9_-]+$', () => {
    expect(() =>
      SettingsSchema.parse({ gateway: { principals: [{ id: 'a/b', token: 'tok-a' }] } }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({ gateway: { principals: [{ id: '', token: 'tok-a' }] } }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({ gateway: { principals: [{ id: '../x', token: 'tok-a' }] } }),
    ).toThrow();
  });

  test('rejects an empty token', () => {
    expect(() =>
      SettingsSchema.parse({ gateway: { principals: [{ id: 'alice', token: '' }] } }),
    ).toThrow();
  });
});

// Phase F T3 — gateway.channels: webhook/telegram/slack channel adapters that
// drive harness turns. Each ENABLED channel (a) binds to a Phase-E principal
// (principalId ∈ gateway.principals, so a channel is isolated to one principal),
// and (b) must carry its required secret(s) in config. permissionMode excludes
// 'bypass' BY CONSTRUCTION (the enum is ['default','ask']) — a remote channel
// running in bypass is an RCE, so it is rejected at the type level, not a refine.
// Secret-vs-env decision: this schema requires the secret field present IN CONFIG.
// Boot-time env resolution (e.g. SLACK_SIGNING_SECRET) is handled in F-T7 by
// injecting env into the config object BEFORE parse — keeping this schema pure /
// env-free. So an enabled channel whose secret arrives only via env passes the
// schema once F-T7 has merged it in.
describe('SettingsSchema — gateway.channels', () => {
  const principals = [
    { id: 'wh', token: 't1' },
    { id: 'tg', token: 't2' },
    { id: 'sl', token: 't3' },
  ];

  test('accepts a full channels block bound to principals', () => {
    const p = SettingsSchema.parse({
      gateway: {
        principals,
        channels: {
          webhook: { enabled: true, secret: 'whsec', principalId: 'wh' },
          telegram: { enabled: true, botToken: 'b', principalId: 'tg' },
          slack: { enabled: true, signingSecret: 'ss', botToken: 'bt', principalId: 'sl' },
        },
      },
    });
    expect(p.gateway?.channels?.webhook).toEqual({
      enabled: true,
      secret: 'whsec',
      principalId: 'wh',
    });
    expect(p.gateway?.channels?.telegram).toEqual({
      enabled: true,
      botToken: 'b',
      principalId: 'tg',
    });
    expect(p.gateway?.channels?.slack).toEqual({
      enabled: true,
      signingSecret: 'ss',
      botToken: 'bt',
      principalId: 'sl',
    });
  });

  test('absent channels stays valid', () => {
    expect(SettingsSchema.parse({ gateway: { principals } }).gateway?.channels).toBeUndefined();
    expect(SettingsSchema.parse({ gateway: {} }).gateway?.channels).toBeUndefined();
    expect(SettingsSchema.parse({}).gateway?.channels).toBeUndefined();
  });

  test('rejects unknown keys in a channel (strict)', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals,
          channels: { webhook: { enabled: true, secret: 's', principalId: 'wh', bogus: 1 } },
        },
      }),
    ).toThrow();
  });

  test('accepts permissionMode default and ask', () => {
    const dflt = SettingsSchema.parse({
      gateway: {
        principals,
        channels: {
          webhook: { enabled: true, secret: 's', principalId: 'wh', permissionMode: 'default' },
        },
      },
    });
    expect(dflt.gateway?.channels?.webhook?.permissionMode).toBe('default');
    const ask = SettingsSchema.parse({
      gateway: {
        principals,
        channels: {
          webhook: { enabled: true, secret: 's', principalId: 'wh', permissionMode: 'ask' },
        },
      },
    });
    expect(ask.gateway?.channels?.webhook?.permissionMode).toBe('ask');
  });

  test("rejects permissionMode 'bypass' on any channel (remote bypass = RCE)", () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals,
          channels: {
            webhook: { enabled: true, secret: 's', principalId: 'wh', permissionMode: 'bypass' },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals,
          channels: {
            telegram: { enabled: true, botToken: 'b', principalId: 'tg', permissionMode: 'bypass' },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals,
          channels: {
            slack: {
              enabled: true,
              signingSecret: 'ss',
              botToken: 'bt',
              principalId: 'sl',
              permissionMode: 'bypass',
            },
          },
        },
      }),
    ).toThrow();
  });

  test('rejects an enabled channel whose principalId is not in principals', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals,
          channels: { webhook: { enabled: true, secret: 'whsec', principalId: 'ghost' } },
        },
      }),
    ).toThrow();
  });

  test('rejects an enabled channel when principals is absent entirely', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          channels: { webhook: { enabled: true, secret: 'whsec', principalId: 'wh' } },
        },
      }),
    ).toThrow();
  });

  test('rejects an enabled webhook missing its secret', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: { principals, channels: { webhook: { enabled: true, principalId: 'wh' } } },
      }),
    ).toThrow();
  });

  test('rejects an enabled telegram missing its botToken', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: { principals, channels: { telegram: { enabled: true, principalId: 'tg' } } },
      }),
    ).toThrow();
  });

  test('rejects an enabled slack missing signingSecret', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals,
          channels: { slack: { enabled: true, botToken: 'bt', principalId: 'sl' } },
        },
      }),
    ).toThrow();
  });

  test('rejects an enabled slack missing botToken', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals,
          channels: { slack: { enabled: true, signingSecret: 'ss', principalId: 'sl' } },
        },
      }),
    ).toThrow();
  });

  test('a disabled channel is NOT validated for secret/principal binding', () => {
    // enabled: false → no principalId-in-principals check, no secret check.
    const p = SettingsSchema.parse({
      gateway: {
        principals,
        channels: {
          webhook: { enabled: false, principalId: 'ghost' },
          telegram: { enabled: false, principalId: 'ghost' },
          slack: { enabled: false, principalId: 'ghost' },
        },
      },
    });
    expect(p.gateway?.channels?.webhook?.enabled).toBe(false);
  });

  test('a channel with enabled omitted is NOT validated (disabled by default)', () => {
    const p = SettingsSchema.parse({
      gateway: {
        principals,
        channels: { webhook: { principalId: 'ghost' } },
      },
    });
    expect(p.gateway?.channels?.webhook?.principalId).toBe('ghost');
  });
});

// SMS channel (Twilio) — D1/D4/D8. Unlike the webhook/slack/telegram channels,
// SMS binds the SENDER to a principal via a `senders` ALLOW-LIST (a number is
// publicly textable, so an inbound only drives a turn if its From is mapped).
// Validation for an ENABLED sms channel: provider must be literal 'twilio';
// `senders` non-empty; every senders VALUE (a principalId) ∈ gateway.principals;
// accountSid + authToken + fromNumber present (env merged before parse, like the
// other channels); permissionMode excludes 'bypass' (the enum is ['default','ask'],
// rejected at the type level — a remote channel in bypass is an RCE).
describe('SettingsSchema — gateway.channels.sms (Twilio)', () => {
  const principals = [
    { id: 'sms', token: 't1' },
    { id: 'other', token: 't2' },
  ];
  const valid = {
    enabled: true,
    provider: 'twilio',
    accountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    authToken: 'tok',
    fromNumber: '+15550001111',
    senders: { '+15551234567': 'sms' },
  } as const;

  test('accepts a valid enabled sms channel bound to a principal', () => {
    const p = SettingsSchema.parse({
      gateway: { principals, channels: { sms: { ...valid, permissionMode: 'default' } } },
    });
    expect(p.gateway?.channels?.sms).toEqual({
      enabled: true,
      provider: 'twilio',
      accountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      authToken: 'tok',
      fromNumber: '+15550001111',
      senders: { '+15551234567': 'sms' },
      permissionMode: 'default',
    });
  });

  test('senders defaults to an empty object when omitted', () => {
    // A disabled sms channel with no senders parses; the default is {}.
    const p = SettingsSchema.parse({
      gateway: { principals, channels: { sms: { provider: 'twilio' } } },
    });
    expect(p.gateway?.channels?.sms?.senders).toEqual({});
  });

  test('absent sms channel stays valid', () => {
    expect(
      SettingsSchema.parse({ gateway: { principals } }).gateway?.channels?.sms,
    ).toBeUndefined();
  });

  test('rejects unknown keys in the sms channel (strict)', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: { principals, channels: { sms: { ...valid, bogus: 1 } } },
      }),
    ).toThrow();
  });

  test("rejects provider other than 'twilio'", () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: { principals, channels: { sms: { ...valid, provider: 'nexmo' } } },
      }),
    ).toThrow();
  });

  test("rejects permissionMode 'bypass' (remote bypass = RCE)", () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: { principals, channels: { sms: { ...valid, permissionMode: 'bypass' } } },
      }),
    ).toThrow();
  });

  test('rejects an enabled sms channel with an empty senders map', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: { principals, channels: { sms: { ...valid, senders: {} } } },
      }),
    ).toThrow(/senders/);
  });

  test('rejects an enabled sms channel whose sender maps to a ghost principal', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          principals,
          channels: { sms: { ...valid, senders: { '+15551234567': 'ghost' } } },
        },
      }),
    ).toThrow(/not a declared gateway\.principals id/);
  });

  test('rejects an enabled sms channel when principals is absent entirely', () => {
    expect(() =>
      SettingsSchema.parse({
        gateway: { channels: { sms: valid } },
      }),
    ).toThrow();
  });

  test('rejects an enabled sms channel missing accountSid', () => {
    const { accountSid: _omit, ...noSid } = valid;
    expect(() =>
      SettingsSchema.parse({ gateway: { principals, channels: { sms: noSid } } }),
    ).toThrow();
  });

  test('rejects an enabled sms channel missing authToken', () => {
    const { authToken: _omit, ...noTok } = valid;
    expect(() =>
      SettingsSchema.parse({ gateway: { principals, channels: { sms: noTok } } }),
    ).toThrow();
  });

  test('rejects an enabled sms channel missing fromNumber', () => {
    const { fromNumber: _omit, ...noFrom } = valid;
    expect(() =>
      SettingsSchema.parse({ gateway: { principals, channels: { sms: noFrom } } }),
    ).toThrow();
  });

  test('a disabled sms channel is NOT validated for senders/creds/principal', () => {
    // enabled: false → no senders / cred / principal checks. provider is still
    // required (it's the non-optional discriminator), but everything else is lax.
    const p = SettingsSchema.parse({
      gateway: {
        principals,
        channels: { sms: { enabled: false, provider: 'twilio', senders: { '+1': 'ghost' } } },
      },
    });
    expect(p.gateway?.channels?.sms?.enabled).toBe(false);
  });

  test('an sms channel with enabled omitted is NOT validated (disabled by default)', () => {
    const p = SettingsSchema.parse({
      gateway: {
        principals,
        channels: { sms: { provider: 'twilio', senders: { '+1': 'ghost' } } },
      },
    });
    expect(p.gateway?.channels?.sms?.provider).toBe('twilio');
  });
});
