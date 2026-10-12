import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import type { AgentDefinition } from '@yevgetman/sov-sdk/agents/types';
import type { AssistantMessage } from '@yevgetman/sov-sdk/core/types';
import type { ResolvedProvider } from '@yevgetman/sov-sdk/providers/resolver';
import type { LLMProvider } from '@yevgetman/sov-sdk/providers/types';
import { LaneSemaphores } from '@yevgetman/sov-sdk/runtime/laneSemaphores';
import { PathLockManager } from '@yevgetman/sov-sdk/runtime/pathLock';
import { SubagentScheduler } from '@yevgetman/sov-sdk/runtime/scheduler';
import { createSkillActivationState } from '@yevgetman/sov-sdk/skills/activation';
import {
  InMemorySkillContinuityStore,
  type SkillContinuityPort,
  createSkillContinuity,
} from '@yevgetman/sov-sdk/skills/continuity';
import { createSkillRuntime } from '@yevgetman/sov-sdk/skills/runtime';
import { InMemorySkillStore } from '@yevgetman/sov-sdk/skills/store';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

function agent(name: string, role?: string): AgentDefinition {
  return {
    name,
    description: name,
    systemPrompt: name,
    allowedTools: [],
    ...(role ? { role } : {}),
    maxTurns: 3,
    readOnly: true,
    supportsMissionState: false,
    inheritParentTools: true,
    allowedSubagents: [],
    path: `/fixture/${name}`,
    realpath: `/fixture/${name}`,
    dir: '/fixture',
    source: 'bundle',
    trustTier: 'builtin',
  };
}

for (const restricted of [true, false]) {
  test.each([1, 2])(
    `subprocess delegation after %i native hops ${restricted ? 'keeps the skill restriction' : 'accepts an unrestricted skill'}`,
    async (nativeHops) => {
      let subprocessCalls = 0;
      let nativeCalls = 0;
      let nestedError: string | undefined;
      let childContext: ToolContext | undefined;
      const continuityStore = new InMemorySkillContinuityStore();
      const childPorts = new Map<string, SkillContinuityPort>();
      const activatedChildren = new Set<string>();
      const delegate = buildTool({
        name: 'Delegate',
        description: () => 'Delegate the task',
        inputSchema: z.object({}),
        checkPermissions: async () => ({ behavior: 'allow' }),
        call: async (_input, context) => {
          childContext = context;
          if (!context.skillContinuity || !context.skillActivation)
            throw new Error('missing child continuity lifetime');
          await context.skillContinuity.activated(
            {
              name: 'child-note',
              revision: 'a'.repeat(64),
              source: 'model',
              args: '',
              allowedTools: [],
              allowedResourceRoots: [],
            },
            'Keep the child workflow.',
            context.skillActivation.turnId,
          );
          activatedChildren.add(context.sessionId);
          try {
            await scheduler.delegate({
              agentName:
                (context.delegationDepth ?? 0) < nativeHops ? 'native' : 'subscription-executor',
              prompt: 'Run the nested task',
              parentSessionId: context.sessionId,
              parentToolPool: context.parentToolPool ?? [],
              parentToolContext: context,
            });
          } catch (error) {
            nestedError = String(error);
          }
          return { data: 'Delegation checked' };
        },
      });
      const state = createSkillActivationState({
        tools: [delegate],
        canUseTool: async () => ({ behavior: 'allow' }),
      });
      const context: ToolContext = {
        cwd: tmpdir(),
        sessionId: 'parent',
        skillActivation: state,
        skillContinuityManagedByHost: true,
        skillContinuity: createSkillContinuity({
          scope: { profile: 'fixture', owner: 'owner', session: 'parent' },
          store: continuityStore,
        }),
        forkSkillContinuity: async (childSessionId) => {
          const child = createSkillContinuity({
            scope: { profile: 'fixture', owner: 'owner', session: childSessionId },
            store: continuityStore,
          });
          childPorts.set(childSessionId, child);
          return child;
        },
      };
      const runtime = createSkillRuntime({ store: new InMemorySkillStore() });
      await runtime.mutate({
        action: 'create',
        name: 'workflow',
        content: `---\nname: workflow\ndescription: Delegate the workflow\n${restricted ? 'allowedTools: [Delegate]\n' : ''}---\nCheck the task.`,
      });
      await runtime.activate('workflow', { source: 'user', toolContext: context, state });
      const agents = [agent('native'), agent('subscription-executor', 'subscription-executor')];
      const transport: LLMProvider = {
        name: 'fake',
        async *stream(request) {
          nativeCalls++;
          const needsDelegation = !request.messages.some((message) => message.role === 'assistant');
          const message: AssistantMessage = {
            role: 'assistant',
            content: needsDelegation
              ? [{ type: 'tool_use', id: 'delegate-call', name: 'Delegate', input: {} }]
              : [{ type: 'text', text: 'done' }],
          };
          yield { type: 'assistant_message', message };
          yield { type: 'message_stop', stop_reason: needsDelegation ? 'tool_use' : 'end_turn' };
          return message;
        },
      };
      const resolved: ResolvedProvider = {
        transport: transport as unknown as ResolvedProvider['transport'],
        client: transport,
        baseUrl: 'fake://',
        model: 'fake',
        contextLength: 32000,
        authType: 'none',
        metadata: { provider: 'fake' },
      };
      const scheduler = new SubagentScheduler({
        agents: { agents, byName: new Map(agents.map((value) => [value.name, value])) },
        laneSemaphores: new LaneSemaphores({}),
        pathLock: new PathLockManager(),
        resolveProvider: () => resolved,
        createChildSession: ({ parentSessionId }) => `${parentSessionId}-child`,
        defaultProvider: 'fake',
        defaultModel: 'fake',
        maxTokens: 256,
        subscriptionExecutor: { enabled: true },
        runSubprocessExecutor: async () => {
          subprocessCalls++;
          return {
            terminal: { reason: 'completed' },
            iterationsUsed: 1,
            toolCallCount: 0,
            distinctToolNames: [],
            messages: [],
          };
        },
      });
      const result = await scheduler.delegate({
        agentName: 'native',
        prompt: 'Check nested delegation',
        parentSessionId: 'parent',
        parentToolPool: [delegate],
        parentToolContext: context,
        canUseTool: async () => ({ behavior: 'allow' }),
      });
      expect(result.terminal.reason).toBe('completed');
      expect(nativeCalls).toBe(2 * nativeHops);
      // The child has fresh activation records. The ancestor's restriction must
      // still prevent delegating to an executor that cannot enforce that floor.
      expect(childContext?.skillActivation?.activations).toEqual([]);
      expect(childContext?.skillContinuityManagedByHost).toBe(false);
      expect(activatedChildren.size).toBe(nativeHops);
      for (const childId of activatedChildren)
        expect(
          (await childPorts.get(childId)?.exportRecords())?.find(
            (record) => record.name === 'child-note',
          )?.outcome,
        ).toBe('succeeded');
      expect(subprocessCalls).toBe(restricted ? 0 : 1);
      if (restricted) expect(nestedError).toContain('cannot be enforced');
      else expect(nestedError).toBeUndefined();
      expect(scheduler.activeChildren('parent')).toBe(0);
      expect(scheduler.activeChildren('parent-child')).toBe(0);
      expect(scheduler.activeChildren('parent-child-child')).toBe(0);
      runtime.dispose();
    },
  );
}
