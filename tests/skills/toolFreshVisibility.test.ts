import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { loadSkillFromPath } from '@yevgetman/sov-sdk/skills/loader';
import { createSkillRegistryManager } from '@yevgetman/sov-sdk/skills/registry';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';

test.each(['requires_tools: [Bash]', 'fallback_for_tools: [SkillTool]'])(
  'fallback activation rejects fresh prerequisites (%s)',
  async (gate) => {
    const root = await mkdtemp(join(tmpdir(), 'skill-tool-fresh-'));
    try {
      const path = join(root, 'SKILL.md');
      const initial =
        '---\nname: safe\ndescription: Fresh activation fixture\n---\nFresh guidance.';
      await writeFile(path, initial);
      const cached = await loadSkillFromPath(path, { source: 'project', trustTier: 'trusted' });
      if (!cached) throw new Error('fixture failed to load');
      const manager = createSkillRegistryManager({
        load: async () => ({ registry: { skills: [cached], byName: new Map([['safe', cached]]) } }),
      });
      await manager.refresh();
      await writeFile(
        path,
        `---\nname: safe\ndescription: Fresh activation fixture\nmetadata:\n  harness:\n    ${gate}\n---\nFresh unavailable guidance.`,
      );
      const state = createSkillActivationState({ tools: [SkillTool] });
      await expect(
        SkillTool.call(
          { skill: 'safe' },
          {
            cwd: root,
            sessionId: 'fresh-activation',
            skillRegistryManager: manager,
            skillActivation: state,
          },
        ),
      ).rejects.toThrow('unavailable');
      expect(state.activations).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
