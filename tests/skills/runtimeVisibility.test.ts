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

function providerWithCalls(calls: { name: string; input: unknown }[], pageCatalog = false) {
  const requests: ProviderRequest[] = [];
  const listedPages: string[] = [];
  const issuedCalls: { id: string; name: string }[] = [];
  const cursors = new Set<string>();
  let previous: { id: string; name: string; input: unknown } | undefined;
  const provider: LLMProvider = {
    name: 'visibility-fixture',
    async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      if (pageCatalog && previous?.name === 'skills_list') {
        const previousId = previous.id;
        const result = request.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_result' && block.tool_use_id === previousId);
        if (result?.type !== 'tool_result' || result.is_error)
          throw new Error('missing successful catalog page');
        listedPages.push(result.content);
        const data = JSON.parse(result.content.slice(result.content.indexOf('{'))) as {
          nextCursor?: string;
          truncated: boolean;
          budgetExhausted?: boolean;
        };
        if (data.nextCursor) {
          if (cursors.has(data.nextCursor)) throw new Error('catalog cursor did not advance');
          cursors.add(data.nextCursor);
          calls.unshift({
            name: 'skills_list',
            input: { ...(previous.input as Record<string, unknown>), cursor: data.nextCursor },
          });
        } else if (data.truncated || data.budgetExhausted) {
          throw new Error('catalog enumeration did not complete');
        }
      }
      const call = calls.shift();
      previous = call ? { id: `call-${requests.length}`, ...call } : undefined;
      if (previous) issuedCalls.push({ id: previous.id, name: previous.name });
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
  return { provider, requests, listedPages, issuedCalls };
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
      const { provider, requests, listedPages, issuedCalls } = providerWithCalls(
        [
          { name: 'skills_list', input: {} },
          { name: 'SkillTool', input: { skill: 'terminalOnly' } },
        ],
        true,
      );
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
        expect(listedPages.length).toBeGreaterThan(0);
        const listed = listedPages.join('\n');
        expect(listed).toContain('terminalFallback');
        expect(listed).not.toContain('terminalOnly');
        expect(listed).toContain('terminalSetFallback');
        expect(listed).not.toContain('terminalSetOnly');
        if (staleHostNames) expect(listed).toContain('customProfile');
        else expect(listed).not.toContain('customProfile');
        const activationId = issuedCalls.find((call) => call.name === 'SkillTool')?.id;
        const activation = requests
          .at(-1)
          ?.messages.flatMap((message) => message.content)
          .find((block) => block.type === 'tool_result' && block.tool_use_id === activationId);
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
      const { provider, requests, listedPages } = providerWithCalls(
        [
          { name: 'SkillTool', input: { skill: 'restricted' } },
          { name: 'skills_list', input: {} },
        ],
        true,
      );
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
        expect(listedPages.length).toBeGreaterThan(0);
        const listed = listedPages.join('\n');
        expect(listed).not.toContain('terminalOnly');
        expect(listed).not.toContain('terminalSetOnly');
        expect(listed).toContain('terminalFallback');
        expect(listed).toContain('terminalSetFallback');
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
