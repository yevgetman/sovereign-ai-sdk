import { describe, expect, test } from 'bun:test';
import {
  createSkillRegistryManager,
  getSkillRegistry,
  getSkillRegistrySnapshot,
  remoteSkillDiagnostics,
} from '../../packages/sdk/src/skills/registry.js';
import type { Skill, SkillRegistry } from '../../packages/sdk/src/skills/types.js';
import { SkillsListTool } from '../../packages/sdk/src/tools/SkillsListTool.js';

function skill(name: string, requiresTools: string[] = []): Skill {
  return {
    name,
    description: name,
    whenToUse: name,
    allowedTools: [],
    path: `/private/${name}/SKILL.md`,
    realpath: `/private/${name}/SKILL.md`,
    dir: `/private/${name}`,
    source: 'user',
    trustTier: 'trusted',
    allowShellInterpolation: false,
    metadata: {
      harness: {
        requiresTools,
        requiresToolsets: [],
        fallbackForTools: [],
        fallbackForToolsets: [],
      },
    },
    guard: { action: 'allow', findings: [] },
    body: `body ${name}`,
  };
}
function registry(...skills: Skill[]): SkillRegistry {
  return { skills, byName: new Map(skills.map((s) => [s.name, s])) };
}

describe('live skill registry', () => {
  test('live tool views preserve custom profiles while replacing stale inferred capabilities', async () => {
    const custom = skill('customProfile');
    custom.metadata.harness.requiresToolsets = ['research-profile'];
    const terminal = skill('terminalOnly');
    terminal.metadata.harness.requiresToolsets = ['terminal'];
    const fallback = skill('terminalFallback');
    fallback.metadata.harness.fallbackForToolsets = ['terminal'];
    const manager = createSkillRegistryManager({
      load: async () => ({ registry: registry(custom, terminal, fallback) }),
    });
    await manager.refresh();
    const context = {
      cwd: '/nonexistent',
      sessionId: 'profile-fixture',
      skillRegistryManager: manager,
      activeToolNames: ['skills_list'],
      activeToolsets: ['terminal', 'research-profile'],
    };
    const listed = await SkillsListTool.call({}, context);
    expect(listed.data.skills.map((entry) => entry.name)).toEqual([
      'customProfile',
      'terminalFallback',
    ]);
    const withoutProfile = await SkillsListTool.call({}, { ...context, activeToolsets: [] });
    expect(withoutProfile.data.skills.map((entry) => entry.name)).toEqual(['terminalFallback']);
    const withBash = await SkillsListTool.call(
      {},
      {
        ...context,
        activeToolNames: ['skills_list', 'Bash'],
      },
    );
    expect(withBash.data.skills.map((entry) => entry.name)).toEqual([
      'customProfile',
      'terminalOnly',
    ]);
  });
  test('serializes publication, retains prior generation on failure, and isolates snapshots', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const manager = createSkillRegistryManager({
      load: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        const n = ++calls;
        await new Promise((r) => setTimeout(r, 2));
        active--;
        if (n === 2) throw new Error('private load failure');
        return { registry: registry(skill(`s${n}`)) };
      },
    });
    const events: number[] = [];
    manager.subscribe((e) => events.push(e.generation));
    manager.subscribe(() => {
      throw new Error('observer failed');
    });
    const first = await manager.refresh();
    const bad = manager.refresh();
    const next = manager.refresh();
    await expect(bad).rejects.toThrow('private load failure');
    const third = await next;
    expect(maxActive).toBe(1);
    expect(third.generation).toBe(2);
    expect(events).toEqual([1, 2]);
    expect(first.registry.byName.has('s1')).toBe(true);
    third.registry.byName.clear();
    const mutable = third.registry.skills[0];
    if (!mutable) throw new Error('missing published fixture');
    mutable.body = 'corrupt';
    expect(manager.snapshot().registry.byName.get('s3')?.body).toBe('body s3');
  });
  test('tools observe new generations and current tool visibility without changing old snapshots', async () => {
    let current = registry(skill('original'), skill('shell', ['Bash']));
    const manager = createSkillRegistryManager({ load: async () => ({ registry: current }) });
    await manager.refresh();
    const ctx = {
      cwd: '/nonexistent',
      sessionId: 'unit',
      skillRegistryManager: manager,
      activeToolNames: ['skills_list'],
      activeToolsets: ['skills'],
    };
    const pinned = getSkillRegistrySnapshot(ctx);
    expect(getSkillRegistry(ctx).skills.map((s) => s.name)).toEqual(['original']);
    current = registry(skill('installed'));
    await manager.refresh();
    const output = await SkillsListTool.call({}, { ...ctx });
    expect(output.data.skills.map((s) => s.name)).toEqual(['installed']);
    expect(pinned.registry.skills.map((s) => s.name)).toEqual(['original']);
    expect(getSkillRegistrySnapshot(ctx).generation).toBe(2);
  });
  test('managers do not leak profiles and remote diagnostics strip every private field', async () => {
    const a = createSkillRegistryManager({
      load: async () => ({
        registry: registry(skill('profileA')),
        diagnostics: [
          {
            code: 'load-rejected',
            path: '/secret/path',
            root: '/secret/root',
            realpath: '/secret/canonical',
            message: 'SECRET raw YAML body',
          },
        ],
      }),
    });
    const b = createSkillRegistryManager({
      load: async () => ({ registry: registry(skill('profileB')) }),
    });
    await Promise.all([a.refresh(), b.refresh()]);
    expect(b.snapshot().registry.byName.has('profileA')).toBe(false);
    const remote = remoteSkillDiagnostics(a.snapshot());
    expect(remote.diagnostics).toEqual([{ code: 'load-rejected' }]);
    expect(JSON.stringify(remote)).not.toContain('SECRET');
    expect(JSON.stringify(remote)).not.toContain('/secret');
  });
});
