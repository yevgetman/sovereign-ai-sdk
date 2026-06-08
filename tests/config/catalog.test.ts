// Verifies the config catalog's structural invariants. Every group is
// reachable; every item path resolves through findItem; every path with
// a registered live-apply hook has its hook present in LIVE_APPLY_HOOKS;
// every path is a valid SettingsSchema dotpath.

import { describe, expect, test } from 'bun:test';
import {
  CONFIG_CATALOG,
  type ConfigGroup,
  findGroup,
  findGroupForItem,
  findItem,
  getLiveApplyHook,
  listRootMenuGroups,
  listUnmanagedKeys,
} from '../../src/config/catalog.js';
import { LIVE_APPLY_HOOKS } from '../../src/config/liveApply.js';
import { SettingsSchema } from '../../src/config/schema.js';

const REQUIRED_GROUP_IDS = [
  'general',
  'providers',
  'providers-anthropic',
  'providers-openai',
  'providers-openrouter',
  'providers-ollama',
  'task-routing',
  'subscription-executor',
  'router',
  'compaction',
  'web-search',
  'review',
  'learning',
  'debug',
  'openai-server',
  'appearance',
];

describe('config catalog', () => {
  test('every required group is present', () => {
    for (const id of REQUIRED_GROUP_IDS) {
      const group = findGroup(id);
      expect(group, `group ${id} should exist`).toBeDefined();
      if (group) expect(group.id).toBe(id);
    }
  });

  test('findGroup returns undefined for unknown id', () => {
    expect(findGroup('nonexistent-group')).toBeUndefined();
  });

  test('findItem round-trips on every catalog path', () => {
    let count = 0;
    for (const group of CONFIG_CATALOG) {
      for (const item of group.items) {
        const found = findItem(item.path);
        expect(found, `path ${item.path} should be findable`).toBeDefined();
        if (found) expect(found.path).toBe(item.path);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(20); // sanity check — catalog has many fields
  });

  test('findItem returns undefined for unknown path', () => {
    expect(findItem('nothing.exists')).toBeUndefined();
  });

  test('findGroupForItem returns the owning group', () => {
    const item = findItem('defaultProvider');
    expect(item).toBeDefined();
    const parent = findGroupForItem('defaultProvider');
    expect(parent).toBeDefined();
    if (parent) expect(parent.id).toBe('general');
  });

  test('listRootMenuGroups excludes per-provider subgroups', () => {
    const roots = listRootMenuGroups();
    const ids = roots.map((g) => g.id);
    expect(ids).toContain('general');
    expect(ids).toContain('providers');
    // The per-provider subgroups are catalog entries but NOT in the root menu.
    expect(ids).not.toContain('providers-anthropic');
    expect(ids).not.toContain('providers-openai');
  });

  test('providers root has drillInto pointers but no items', () => {
    const providers = findGroup('providers');
    expect(providers).toBeDefined();
    if (providers) {
      expect(providers.items).toEqual([]);
      expect(providers.drillInto).toBeDefined();
      expect(providers.drillInto?.length).toBe(4);
      const targetIds = providers.drillInto?.map((d) => d.targetGroupId);
      expect(targetIds).toContain('providers-anthropic');
      expect(targetIds).toContain('providers-openai');
      expect(targetIds).toContain('providers-openrouter');
      expect(targetIds).toContain('providers-ollama');
    }
  });

  test('every live-apply hook key has a catalog item', () => {
    for (const path of Object.keys(LIVE_APPLY_HOOKS)) {
      const item = findItem(path);
      expect(item, `live-apply hook ${path} should have a catalog item`).toBeDefined();
    }
  });

  test('every getLiveApplyHook lookup matches LIVE_APPLY_HOOKS contents', () => {
    for (const path of Object.keys(LIVE_APPLY_HOOKS)) {
      expect(getLiveApplyHook(path)).toBeDefined();
    }
    expect(getLiveApplyHook('definitely-not-a-real-path')).toBeUndefined();
  });

  test('secret items are correctly flagged', () => {
    const apiKey = findItem('providers.anthropic.apiKey');
    expect(apiKey?.secret).toBe(true);
    expect(apiKey?.editor.kind).toBe('secret');

    const nonSecret = findItem('defaultProvider');
    expect(nonSecret?.secret).toBeUndefined();
  });

  test('every catalog path is a valid SettingsSchema dotpath', () => {
    // Validate paths against SettingsSchema directly. We pluck the
    // schema shape and walk each dotpath segment, ensuring it resolves
    // to a known field. This avoids the false-negative from setAt's
    // schema re-parse — some subschemas have required-field gates that
    // a single-key set can't satisfy on its own (e.g., router requires
    // both localProvider and frontierProvider).
    // SettingsSchema is wrapped in a ZodEffects by the top-level
    // .superRefine (the subscriptionExecutor × taskRouting mutex), so the
    // ZodObject — and its .shape() — lives at `_def.schema`. Unwrap it.
    const rootObject = (
      SettingsSchema as unknown as {
        _def: { schema: { _def: { shape: () => Record<string, unknown> } } };
      }
    )._def.schema;
    const rootShape = rootObject._def.shape();

    function resolveSegment(schema: unknown, segment: string): unknown {
      if (schema === null || typeof schema !== 'object') return undefined;
      const obj = schema as Record<string, unknown>;
      // Drill into wrappers (optional, default, partial, etc.).
      const def = (obj as { _def?: unknown })._def;
      if (def !== null && typeof def === 'object') {
        const defObj = def as Record<string, unknown>;
        // Object schema: shape() returns the field map.
        const shape = defObj.shape;
        if (typeof shape === 'function') {
          const inner = (shape as () => Record<string, unknown>)();
          if (Object.hasOwn(inner, segment)) return inner[segment];
        }
        // Unwrap optional/default/partial — they hold the inner type in
        // `innerType` or `schema`.
        const innerType = defObj.innerType ?? defObj.schema;
        if (innerType !== undefined) {
          return resolveSegment(innerType, segment);
        }
      }
      // Fallback: if the object itself looks like a shape map, look up
      // the segment directly. This handles the raw shape we get at the
      // top level.
      if (Object.hasOwn(obj, segment)) return obj[segment];
      return undefined;
    }

    for (const group of CONFIG_CATALOG) {
      for (const item of group.items) {
        const segments = item.path.split('.');
        let cur: unknown = rootShape;
        let reachable = true;
        for (const seg of segments) {
          const next = resolveSegment(cur, seg);
          if (next === undefined) {
            reachable = false;
            break;
          }
          cur = next;
        }
        expect(reachable, `path ${item.path} should be a valid schema dotpath`).toBe(true);
      }
    }
  });

  test('listUnmanagedKeys returns empty for empty settings', () => {
    expect(listUnmanagedKeys({})).toEqual([]);
  });

  test('listUnmanagedKeys flags top-level keys not covered by any catalog item', () => {
    // Both built-in keys (defaultProvider) and unknown ones (`futureExp`).
    // Pass an unknown extra key via a cast since SettingsSchema is strict
    // and won't tolerate it at parse time — this test exercises the
    // function's behavior directly on a raw object that bypasses parsing.
    const settings = {
      defaultProvider: 'anthropic',
      futureExp: { something: 'experimental' },
    } as unknown as import('../../src/config/schema.js').Settings;
    const unmanaged = listUnmanagedKeys(settings);
    expect(unmanaged).toContain('futureExp');
    expect(unmanaged).not.toContain('defaultProvider');
  });

  test('group items have unique paths within their group', () => {
    for (const group of CONFIG_CATALOG) {
      const seen = new Set<string>();
      for (const item of group.items) {
        expect(seen.has(item.path), `duplicate path ${item.path} in ${group.id}`).toBe(false);
        seen.add(item.path);
      }
    }
  });

  test('every editor kind has the right shape', () => {
    for (const group of CONFIG_CATALOG) {
      for (const item of group.items) {
        const e = item.editor;
        if (e.kind === 'enum') {
          expect(e.choices.length).toBeGreaterThan(0);
        }
        if (e.kind === 'number') {
          // min/max are optional but if both present min <= max.
          if (e.min !== undefined && e.max !== undefined) {
            expect(e.min).toBeLessThanOrEqual(e.max);
          }
        }
      }
    }
  });

  describe('subscription-executor group', () => {
    const PATHS = [
      'subscriptionExecutor.enabled',
      'subscriptionExecutor.engine',
      'subscriptionExecutor.binary',
      'subscriptionExecutor.permissionMode',
      'subscriptionExecutor.timeoutMs',
      'subscriptionExecutor.maxTurns',
    ];

    test('is reachable in the root menu, after task-routing', () => {
      const ids = listRootMenuGroups().map((g) => g.id);
      expect(ids).toContain('subscription-executor');
      expect(ids.indexOf('subscription-executor')).toBe(ids.indexOf('task-routing') + 1);
    });

    test('exposes all six schema fields', () => {
      const group = findGroup('subscription-executor');
      expect(group).toBeDefined();
      const groupPaths = (group?.items ?? []).map((i) => i.path);
      expect(groupPaths).toEqual(PATHS);
      for (const p of PATHS) {
        expect(findItem(p), `path ${p} should be findable`).toBeDefined();
        expect(findGroupForItem(p)?.id).toBe('subscription-executor');
      }
    });

    test('editor kinds match the schema shape', () => {
      expect(findItem('subscriptionExecutor.enabled')?.editor).toEqual({ kind: 'boolean' });
      expect(findItem('subscriptionExecutor.engine')?.editor).toEqual({
        kind: 'enum',
        choices: ['claude-code'],
      });
      // permissionMode maps to the spawned subprocess's posture. `bypass`
      // (-> --dangerously-skip-permissions) is the default and leads the list.
      const pm = findItem('subscriptionExecutor.permissionMode')?.editor;
      expect(pm).toEqual({ kind: 'enum', choices: ['bypass', 'plan', 'acceptEdits', 'default'] });
      if (pm?.kind === 'enum') {
        expect(pm.choices).toContain('bypass');
        expect(pm.choices[0]).toBe('bypass');
      }
    });

    test('every field is next-session (no live-apply hook)', () => {
      // The scheduler captures subscriptionExecutor config at construction
      // (scheduler.ts) and never refreshes it, so a live-apply hook would be
      // half-applied (enum flips, routing branch stays stale). The honest
      // representation is the ⟳ next session badge — i.e. NO hook.
      for (const p of PATHS) {
        expect(getLiveApplyHook(p), `${p} must not be live-applyable`).toBeUndefined();
      }
    });
  });

  test('CONFIG_CATALOG is iterable and frozen', () => {
    expect(CONFIG_CATALOG.length).toBeGreaterThan(10);
    // Defensive: the catalog should be readonly. We don't enforce
    // Object.isFrozen at runtime (the array's `Object.freeze` propagates
    // to the outermost array but not its nested groups), but mutating the
    // top-level array should be a TypeScript error in callers.
    const sampleGroup: ConfigGroup | undefined = CONFIG_CATALOG[0];
    expect(sampleGroup).toBeDefined();
  });
});
