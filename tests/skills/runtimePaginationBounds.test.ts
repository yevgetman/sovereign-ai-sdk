import { describe, expect, test } from 'bun:test';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { InMemorySkillStore } from '@yevgetman/sov-sdk/skills/store';
import type { SkillWritableStore } from '@yevgetman/sov-sdk/skills/storeTypes';

const content =
  '---\nname: stable\ndescription: Published fixture\n---\nKeep the accepted generation.';

describe('custom store discovery pagination bounds', () => {
  test('an empty cursor cycle rejects promptly and retains the published generation', async () => {
    const backing = new InMemorySkillStore();
    await backing.mutate({ action: 'create', name: 'stable', content });
    let cyclic = false;
    let calls = 0;
    const store: SkillWritableStore = {
      subscribe: (listener) => backing.subscribe(listener),
      read: (name) => backing.read(name),
      mutate: (change) => backing.mutate(change),
      async list(options) {
        if (!cyclic) return backing.list(options);
        calls++;
        if (calls > 5) throw new Error('fixture stopped unbounded cursor traversal');
        return {
          names: [],
          generation: 'cycle',
          truncated: true,
          nextCursor: options?.cursor === 'a' ? 'b' : 'a',
        };
      },
    };
    const runtime = createSkillRuntime({ store });
    try {
      await runtime.discover();
      const accepted = runtime.snapshot();
      cyclic = true;
      await expect(runtime.refresh()).rejects.toThrow('pagination');
      expect(calls).toBeLessThanOrEqual(3);
      expect(runtime.snapshot().generation).toBe(accepted.generation);
      expect(runtime.snapshot().registry).toEqual(accepted.registry);
      expect(
        runtime.snapshot().diagnostics.some((diagnostic) => diagnostic.code === 'refresh-failed'),
      ).toBe(true);
      expect(runtime.snapshot().registry.byName.has('stable')).toBe(true);
      cyclic = false;
      await runtime.refresh();
      expect(runtime.snapshot().generation).toBeGreaterThan(accepted.generation);
    } finally {
      runtime.dispose();
    }
  });

  test('ever-changing empty cursors cannot bypass the configured enumeration bound', async () => {
    let calls = 0;
    const backing = new InMemorySkillStore();
    const store: SkillWritableStore = {
      subscribe: (listener) => backing.subscribe(listener),
      read: (name) => backing.read(name),
      mutate: (change) => backing.mutate(change),
      async list() {
        calls++;
        if (calls > 6) throw new Error('fixture stopped unbounded empty pages');
        return { names: [], generation: 'stable', truncated: true, nextCursor: `page-${calls}` };
      },
    };
    const runtime = createSkillRuntime({ store, storeDiscoveryLimits: { maxEntries: 2 } });
    try {
      await expect(runtime.discover()).rejects.toThrow('bounded discovery');
      expect(calls).toBeLessThanOrEqual(3);
      expect(runtime.snapshot().generation).toBe(0);
    } finally {
      runtime.dispose();
    }
  });

  test('a finite empty page can precede a valid terminal page within the bound', async () => {
    const backing = new InMemorySkillStore();
    await backing.mutate({ action: 'create', name: 'stable', content });
    let calls = 0;
    const store: SkillWritableStore = {
      subscribe: (listener) => backing.subscribe(listener),
      read: (name) => backing.read(name),
      mutate: (change) => backing.mutate(change),
      async list(options) {
        calls++;
        const page = await backing.list();
        if (calls === 1)
          return { names: [], generation: page.generation, truncated: true, nextCursor: 'next' };
        expect(options?.cursor === 'next' || options?.limit === 1).toBe(true);
        return page;
      },
    };
    const runtime = createSkillRuntime({ store, storeDiscoveryLimits: { maxEntries: 1 } });
    try {
      await runtime.discover();
      expect(calls).toBe(3);
      expect(runtime.snapshot().registry.byName.has('stable')).toBe(true);
    } finally {
      runtime.dispose();
    }
  });
});
