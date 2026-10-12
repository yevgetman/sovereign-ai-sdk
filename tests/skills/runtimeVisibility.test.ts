import { describe, expect, test } from 'bun:test';
import { createAgent } from '@yevgetman/sov-sdk/agent/createAgent';
import type { AssistantMessage, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { InMemorySkillStore } from '@yevgetman/sov-sdk/skills/store';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { CapabilityProfileRegistry } from '@yevgetman/sov-sdk/tool/capabilityProfiles';
import { SkillTool } from '@yevgetman/sov-sdk/tools/SkillTool';
import { SkillsListTool } from '@yevgetman/sov-sdk/tools/SkillsListTool';
import { z } from 'zod';

function providerWithCalls(calls: { name: string; input: unknown }[]) {
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'visibility-fixture',
    async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const call = calls.shift();
      const message: AssistantMessage = {
        role: 'assistant',
        content: call
          ? [{ type: 'tool_use', id: `call-${requests.length}`, ...call }]
          : [{ type: 'text', text: 'done' }],
      };
      yield { type: 'message_start' };
      yield { type: 'message_stop', stop_reason: call ? 'tool_use' : 'end_turn' };
      yield { type: 'assistant_message', message };
      return message;
    },
  };
  return { provider, requests };
}

async function catalog() {
  const runtime = createSkillRuntime({ store: new InMemorySkillStore() });
  for (const [name, requirement] of [
    ['terminalOnly', 'requires_tools: [Bash]'],
    ['terminalFallback', 'fallback_for_tools: [Bash]'],
    ['terminalSetOnly', 'requires_toolsets: [terminal]'],
    ['terminalSetFallback', 'fallback_for_toolsets: [terminal]'],
    ['customProfile', 'requires_toolsets: [custom-profile]'],
  ] as const) {
    await runtime.mutate({
      action: 'create',
      name,
      content: `---\nname: ${name}\ndescription: ${name} workflow\nmetadata:\n  harness:\n    ${requirement}\n---\n${name} private guidance.`,
    });
  }
  return runtime;
}

describe('direct SDK skill visibility follows the effective tool pool', () => {
  test.each([false, true])(
    'native agent filters missing prerequisites and replaces stale host tool names (%s)',
    async (staleHostNames) => {
      const runtime = await catalog();
      const { provider, requests } = providerWithCalls([
        { name: 'skills_list', input: {} },
        { name: 'SkillTool', input: { skill: 'terminalOnly' } },
      ]);
      const agent = createAgent({
        provider,
        model: 'fixture',
        tools: [SkillsListTool, SkillTool],
        skillRuntime: runtime,
      });
      try {
        const stream = agent.run('Run available work.', {
          ...(staleHostNames
            ? {
                toolContext: {
                  cwd: '/virtual-context',
                  sessionId: 'visibility-fixture',
                  activeToolNames: ['Bash'],
                  activeToolsets: ['terminal', 'custom-profile'],
                },
              }
            : {}),
        });
        while (!(await stream.next()).done) {}
        const listed = requests[1]?.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_result' && block.tool_use_id === 'call-1');
        if (listed?.type !== 'tool_result') throw new Error('missing list result');
        expect(listed.content).toContain('terminalFallback');
        expect(listed.content).not.toContain('terminalOnly');
        expect(listed.content).toContain('terminalSetFallback');
        expect(listed.content).not.toContain('terminalSetOnly');
        if (staleHostNames) expect(listed.content).toContain('customProfile');
        else expect(listed.content).not.toContain('customProfile');
        const activation = requests[2]?.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_result' && block.tool_use_id === 'call-2');
        if (activation?.type !== 'tool_result') throw new Error('missing activation result');
        expect(activation.is_error).toBe(true);
        expect(activation.content).not.toContain('terminalOnly private guidance');
      } finally {
        runtime.dispose();
      }
    },
  );

  test.each([false, true])(
    'later tool calls use narrowed activation tools with or without a signal (%s)',
    async (withSignal) => {
      const runtime = await catalog();
      await runtime.mutate({
        action: 'create',
        name: 'restricted',
        content:
          '---\nname: restricted\ndescription: Restricted workflow\nallowedTools: [skills_list]\n---\nRestricted guidance.',
      });
      const bash = buildTool({
        name: 'Bash',
        description: () => 'fixture only',
        inputSchema: z.unknown(),
        checkPermissions: async () => ({ behavior: 'allow' }),
        call: async () => {
          throw new Error('fixture Bash must not execute');
        },
      });
      const { provider, requests } = providerWithCalls([
        { name: 'SkillTool', input: { skill: 'restricted' } },
        { name: 'skills_list', input: {} },
      ]);
      const agent = createAgent({
        provider,
        model: 'fixture',
        tools: [SkillTool, SkillsListTool, bash],
        skillRuntime: runtime,
      });
      try {
        const stream = agent.run('Run available work.', {
          ...(withSignal ? { signal: new AbortController().signal } : {}),
        });
        while (!(await stream.next()).done) {}
        expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(['skills_list']);
        const listed = requests[2]?.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_result' && block.tool_use_id === 'call-2');
        if (listed?.type !== 'tool_result') throw new Error('missing list result');
        expect(listed.content).not.toContain('terminalOnly');
        expect(listed.content).not.toContain('terminalSetOnly');
        expect(listed.content).toContain('terminalFallback');
        expect(listed.content).toContain('terminalSetFallback');
      } finally {
        runtime.dispose();
      }
    },
  );

  test.each([false, true])(
    'selected custom profiles reach native skill catalogs (per-turn override: %s)',
    async (perTurnOverride) => {
      const runtime = await catalog();
      const { provider, requests } = providerWithCalls([{ name: 'skills_list', input: {} }]);
      const agent = createAgent({
        provider,
        model: 'fixture',
        tools: [SkillTool, SkillsListTool],
        skillRuntime: runtime,
        capabilityProfiles: new CapabilityProfileRegistry([
          { name: 'custom-profile', tools: ['skills_list'] },
        ]),
        ...(perTurnOverride ? {} : { toolset: 'custom-profile' }),
      });
      const host = {
        cwd: '/virtual-context',
        sessionId: 'profile-fixture',
        activeToolsets: ['external-host-tag'],
      };
      try {
        const stream = agent.run('List available work.', {
          ...(perTurnOverride ? { toolset: 'custom-profile' } : {}),
          toolContext: host,
        });
        while (!(await stream.next()).done) {}
        expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['skills_list']);
        const listed = requests[1]?.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_result' && block.tool_use_id === 'call-1');
        if (listed?.type !== 'tool_result') throw new Error('missing list result');
        expect(listed.content).toContain('customProfile');
        expect(host.activeToolsets).toEqual(['external-host-tag']);
      } finally {
        runtime.dispose();
      }
    },
  );

  test('direct activation checks state tools even when the host supplies no visibility names', async () => {
    const runtime = await catalog();
    const state = createSkillActivationState({ tools: [SkillTool] });
    try {
      await expect(
        runtime.activate('terminalOnly', {
          source: 'user',
          state,
          toolContext: {
            cwd: '/virtual-context',
            sessionId: 'visibility-fixture',
            activeToolsets: ['terminal', 'custom-profile'],
          },
        }),
      ).rejects.toThrow('unavailable');
      expect(state.activations).toHaveLength(0);
      await expect(
        runtime.activate('terminalSetOnly', {
          source: 'user',
          state,
          toolContext: {
            cwd: '/virtual-context',
            sessionId: 'visibility-fixture',
            activeToolsets: ['terminal', 'custom-profile'],
          },
        }),
      ).rejects.toThrow('unavailable');
      const custom = await runtime.activate('customProfile', {
        source: 'user',
        state,
        toolContext: {
          cwd: '/virtual-context',
          sessionId: 'visibility-fixture',
          activeToolsets: ['terminal', 'custom-profile'],
        },
      });
      expect(custom.prompt).toContain('customProfile private guidance');
    } finally {
      runtime.dispose();
    }
  });

  test.each([false, true])(
    'direct activation uses its supplied state instead of a prior context state (Bash now available: %s)',
    async (bashNowAvailable) => {
      const runtime = await catalog();
      const bash = buildTool({
        name: 'Bash',
        description: () => 'fixture only',
        inputSchema: z.unknown(),
        checkPermissions: async () => ({ behavior: 'allow' }),
        call: async () => {
          throw new Error('fixture Bash must not execute');
        },
      });
      const state = createSkillActivationState({
        tools: bashNowAvailable ? [SkillTool, bash] : [SkillTool],
      });
      const prior = createSkillActivationState({
        tools: bashNowAvailable ? [SkillTool] : [SkillTool, bash],
      });
      try {
        const activation = runtime.activate('terminalOnly', {
          source: 'user',
          state,
          toolContext: {
            cwd: '/virtual-context',
            sessionId: 'reused-context-fixture',
            skillActivation: prior,
          },
        });
        if (bashNowAvailable) {
          expect((await activation).prompt).toContain('terminalOnly private guidance');
          expect(state.activations).toHaveLength(1);
        } else {
          await expect(activation).rejects.toThrow('unavailable');
          expect(state.activations).toHaveLength(0);
        }
        expect(prior.activations).toHaveLength(0);
      } finally {
        runtime.dispose();
      }
    },
  );
});
