import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillFromPath } from '@yevgetman/sov-sdk/skills/loader';
import { createSkillRegistryManager } from '@yevgetman/sov-sdk/skills/registry';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { SkillsViewTool } from '@yevgetman/sov-sdk/tools/SkillsViewTool';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function markdown(name: string, gate = '') {
  return `---\nname: ${name}\ndescription: Fresh visibility fixture\n${gate}\n---\nFresh private guidance.`;
}

test.each([
  ['required tool', 'safe', 'requires_tools: [Bash]'],
  ['required toolset', 'safe', 'requires_toolsets: [terminal]'],
  ['fallback tool', 'safe', 'fallback_for_tools: [skill_view]'],
  ['fallback toolset', 'safe', 'fallback_for_toolsets: [skills]'],
  ['renamed identity', 'renamed', ''],
])('composed skill_view rejects fresh unavailable metadata (%s)', async (_label, name, gate) => {
  const root = await mkdtemp(join(tmpdir(), 'skill-view-fresh-'));
  roots.push(root);
  const path = join(root, 'SKILL.md');
  await writeFile(path, markdown('safe'));
  const cached = await loadSkillFromPath(path, { source: 'project', trustTier: 'trusted' });
  if (!cached) throw new Error('fixture failed to load');
  const manager = createSkillRegistryManager({
    load: async () => ({ registry: { skills: [cached], byName: new Map([['safe', cached]]) } }),
  });
  await manager.refresh();
  const metadata = gate ? `metadata:\n  harness:\n    ${gate}` : '';
  await writeFile(path, markdown(name, metadata));
  await mkdir(join(root, 'refs'));
  await writeFile(join(root, 'refs', 'data.txt'), 'Fresh private reference.');
  const runtime = createSkillRuntime({ manager });
  const context = runtime.bindContext({
    cwd: root,
    sessionId: 'fresh-view',
    skillRegistryManager: manager,
    activeToolNames: ['skill_view'],
  });
  try {
    for (const input of [{ name: 'safe' }, { name: 'safe', path: 'refs/data.txt' }]) {
      await expect(SkillsViewTool.call(input, context)).rejects.toThrow('unavailable');
    }
  } finally {
    runtime.dispose();
  }
});

test('composed skill_view retains permitted fresh text and host profile tags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-view-positive-'));
  roots.push(root);
  const path = join(root, 'SKILL.md');
  await writeFile(path, markdown('safe'));
  const cached = await loadSkillFromPath(path, { source: 'project', trustTier: 'trusted' });
  if (!cached) throw new Error('fixture failed to load');
  const manager = createSkillRegistryManager({
    load: async () => ({ registry: { skills: [cached], byName: new Map([['safe', cached]]) } }),
  });
  await manager.refresh();
  await writeFile(
    path,
    markdown('safe', 'metadata:\n  harness:\n    requires_toolsets: [review-profile]'),
  );
  const runtime = createSkillRuntime({ manager });
  const result = await SkillsViewTool.call(
    { name: 'safe' },
    runtime.bindContext({
      cwd: root,
      sessionId: 'positive-view',
      skillRegistryManager: manager,
      activeToolNames: ['skill_view'],
      activeToolsets: ['review-profile'],
    }),
  );
  expect(result.data.content).toBe('Fresh private guidance.');
  runtime.dispose();
});
