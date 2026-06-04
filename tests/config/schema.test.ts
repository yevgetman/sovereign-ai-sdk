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
