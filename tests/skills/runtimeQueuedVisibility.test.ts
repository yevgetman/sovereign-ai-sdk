import { describe, expect, test } from 'bun:test';
import { createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { loadSkillText } from '@yevgetman/sov-sdk/skills/loader';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';

const tool = (name: string) =>
  buildTool<unknown, unknown>({
    name,
    description: () => name,
    inputSchema: z.unknown(),
    call: async () => ({ data: 'ok' }),
  });
function skill(name: string, policy = '') {
  return loadSkillText(
    `---\nname: ${name}\ndescription: Queued availability fixture\n${policy}\n---\nFollow the available workflow.`,
    {
      source: 'project',
      trustTier: 'trusted',
      path: `/virtual/${name}/SKILL.md`,
    },
  );
}

describe('runtime activation resolves current prerequisites', () => {
  test('a queued workflow cannot activate after the earlier workflow removes its required tools', async () => {
    const readOnly = skill('read-only', 'allowedTools: [Read]');
    const needsWrite = skill('needs-write', 'metadata:\n  harness:\n    requires_tools: [Write]');
    const runtime = createSkillRuntime({
      load: async () => ({
        registry: {
          skills: [readOnly, needsWrite],
          byName: new Map([
            [readOnly.name, readOnly],
            [needsWrite.name, needsWrite],
          ]),
        },
      }),
      resolveSkill: async (current) => current,
      allowedResourceRoots: async () => [],
    });
    await runtime.discover();
    const state = createSkillActivationState({ tools: [tool('Read'), tool('Write')] });
    const options = {
      source: 'user' as const,
      state,
      toolContext: { cwd: '/virtual', sessionId: 'fixture' },
    };
    try {
      const results = await Promise.allSettled([
        runtime.activate('read-only', options),
        runtime.activate('needs-write', options),
      ]);
      expect(results[0]?.status).toBe('fulfilled');
      expect(state.tools.map((current) => current.name)).toEqual(['Read']);
      expect(results[1]?.status).toBe('rejected');
      if (results[1]?.status === 'rejected')
        expect(String(results[1].reason)).toContain('unavailable');
      expect(state.activations.map((activation) => activation.name)).toEqual(['read-only']);
    } finally {
      runtime.dispose();
    }
  });

  test('fresh resolved metadata cannot activate a workflow with an unavailable prerequisite', async () => {
    const cached = skill('changing');
    const current = skill('changing', 'metadata:\n  harness:\n    requires_tools: [Write]');
    const runtime = createSkillRuntime({
      load: async () => ({
        registry: { skills: [cached], byName: new Map([[cached.name, cached]]) },
      }),
      resolveSkill: async () => current,
      allowedResourceRoots: async () => [],
    });
    await runtime.discover();
    const state = createSkillActivationState({ tools: [tool('Read')] });
    try {
      await expect(
        runtime.activate('changing', {
          source: 'user',
          state,
          toolContext: { cwd: '/virtual', sessionId: 'fixture' },
        }),
      ).rejects.toThrow('unavailable');
      expect(state.activations).toHaveLength(0);
      expect(state.tools.map((entry) => entry.name)).toEqual(['Read']);
    } finally {
      runtime.dispose();
    }
  });

  test('fresh matching prerequisites retain custom host profiles and activate successfully', async () => {
    const available = skill(
      'available',
      'metadata:\n  harness:\n    requires_tools: [Write]\n    requires_toolsets: [custom-profile]',
    );
    const runtime = createSkillRuntime({
      load: async () => ({
        registry: { skills: [available], byName: new Map([[available.name, available]]) },
      }),
      resolveSkill: async (current) => current,
      allowedResourceRoots: async () => [],
    });
    await runtime.discover();
    const state = createSkillActivationState({ tools: [tool('Write')] });
    try {
      const result = await runtime.activate('available', {
        source: 'user',
        state,
        toolContext: { cwd: '/virtual', sessionId: 'fixture', activeToolsets: ['custom-profile'] },
      });
      expect(result.prompt).toBe('Follow the available workflow.');
      expect(state.activations).toHaveLength(1);
      expect(state.tools.map((entry) => entry.name)).toEqual(['Write']);
    } finally {
      runtime.dispose();
    }
  });
});
