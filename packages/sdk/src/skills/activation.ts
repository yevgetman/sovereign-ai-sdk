// One activation contract for library hosts, model tools and SOV clients.
// State is owned by a single turn. It can narrow capabilities, never grant them.
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { runTools } from '../core/orchestrator.js';
import type { HookRunner } from '../hooks/types.js';
import type { CanUseTool } from '../permissions/types.js';
import { buildTool } from '../tool/buildTool.js';
import { buildToolScope, filterParseableRules } from '../tool/toolScope.js';
import type { Tool, ToolContext } from '../tool/types.js';
import { assertSkillInvocable } from './descriptor.js';
import { expandSkillPrompt, reloadSkill } from './loader.js';
import type { Skill } from './types.js';

export type SkillActivationSource = 'user' | 'model' | 'command';

export type SkillActivationEnvelope = {
  name: string;
  revision: string;
  source: SkillActivationSource;
  args: string;
  /** Native restriction rules; portable pre-approval metadata is separate. */
  allowedTools: readonly string[];
  allowedResourceRoots: readonly string[];
};

export type SkillActivationState = {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool pool
  tools: Tool<any, any>[];
  canUseTool: CanUseTool;
  /** Scope-only floor, also checked after host/hook input transformations. */
  restrictionCanUseTool: CanUseTool;
  hasHostPermission: boolean;
  hookRunner?: HookRunner;
  activations: SkillActivationEnvelope[];
};

/** Missing host policy permits only an explicit tool allow self-check. */
export const skillDefaultCanUseTool: CanUseTool = async (tool, input, ctx) => {
  const result = await tool.checkPermissions(input, ctx);
  return result.behavior === 'allow'
    ? {
        behavior: 'allow',
        ...(result.updatedInput !== undefined ? { updatedInput: result.updatedInput } : {}),
      }
    : { behavior: 'deny', reason: result.reason ?? 'skill activation requires host approval' };
};

export function createSkillActivationState(opts: {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool pool
  tools: Tool<any, any>[];
  canUseTool?: CanUseTool;
  hookRunner?: HookRunner;
}): SkillActivationState {
  return {
    tools: opts.tools.slice(),
    canUseTool: opts.canUseTool ?? (async () => ({ behavior: 'allow' })),
    restrictionCanUseTool: async () => ({ behavior: 'allow' }),
    hasHostPermission: opts.canUseTool !== undefined,
    activations: [],
    ...(opts.hookRunner ? { hookRunner: opts.hookRunner } : {}),
  };
}

export function skillRestrictionRules(skill: Skill): string[] | undefined {
  if (skill.allowedTools.length === 0) return undefined;
  const rules = filterParseableRules(skill.allowedTools);
  if (rules.length === 0) {
    throw new Error(
      `skill "${skill.name}": every allowedTools entry is invalid — refusing to run with no restriction`,
    );
  }
  return rules;
}

export async function activateSkill(
  skill: Skill,
  opts: {
    source: SkillActivationSource;
    args?: string;
    toolContext: ToolContext;
    state: SkillActivationState;
    allowedResourceRoots?: readonly string[];
    /** Trusted host resolver; permits in-memory catalogs without disk reads. */
    resolveSkill?: (skill: Skill) => Promise<Skill>;
    /** Trusted host directory for virtual stores; no implicit filesystem projection. */
    executionDirectory?: string;
  },
): Promise<{ prompt: string; activation: SkillActivationEnvelope }> {
  const current = await (opts.resolveSkill ?? reloadSkill)(skill);
  assertSkillInvocable(current, opts.source);
  if (current.guard.action === 'block') throw new Error(`skill '${current.name}' is blocked`);
  if (current.guard.action === 'ask') {
    if (!opts.state.hasHostPermission)
      throw new Error(`skill '${current.name}' requires a host guard approval callback`);
    const approval = buildTool<unknown, unknown>({
      name: 'SkillTool',
      description: () => `Approve guarded skill ${current.name}`,
      inputSchema: z.unknown(),
      checkPermissions: async () => ({
        behavior: 'ask',
        reason: `skill '${current.name}' requires guard approval`,
      }),
      call: async () => ({ data: null }),
    });
    const decision = await opts.state.canUseTool(
      approval,
      { skill: current.name },
      opts.toolContext,
    );
    if (decision.behavior !== 'allow')
      throw new Error(`skill '${current.name}' guard permission denied`);
  }
  const rules = skillRestrictionRules(current);
  const scope = buildToolScope({
    tools: opts.state.tools,
    canUseTool: opts.state.canUseTool,
    allowedTools: rules,
  });
  const restrictionScope = buildToolScope({
    tools: opts.state.tools,
    canUseTool: opts.state.restrictionCanUseTool,
    allowedTools: rules,
  });
  const roots = await Promise.all(
    (opts.allowedResourceRoots ?? [dirname(current.realpath)]).map((root) => realpath(root)),
  );
  const prompt = await expandSkillPrompt(
    { ...current, dir: opts.executionDirectory ?? dirname(current.realpath) },
    {
      cwd: opts.toolContext.cwd,
      sessionId: opts.toolContext.sessionId,
      args: opts.args ?? '',
      runShellCommand: async (command, cwd) => {
        if (!opts.state.hasHostPermission)
          throw new Error('skill inline shell requires a host permission callback');
        const bash = scope.tools.find((tool) => tool.name === 'Bash');
        if (!bash)
          throw new Error('skill inline shell denied: Bash is outside the effective tool scope');
        const scopedNames = new Set(scope.tools.map((tool) => tool.name));
        const childPool = (opts.toolContext.parentToolPool ?? scope.tools).filter((tool) =>
          scopedNames.has(tool.name),
        );
        const context = {
          ...opts.toolContext,
          cwd,
          parentToolPool: childPool,
          canUseTool: buildToolScope({
            tools: childPool,
            allowedTools: rules,
            canUseTool: opts.toolContext.canUseTool ?? scope.canUseTool,
          }).canUseTool,
          skillActivation: { ...opts.state, restrictionCanUseTool: restrictionScope.canUseTool },
        };
        const input = bash.inputSchema.parse({ command, timeout_ms: 10_000 });
        let result: Awaited<ReturnType<typeof bash.call>> | undefined;
        const captured = {
          ...bash,
          call: async (...args: Parameters<typeof bash.call>) => {
            result = await bash.call(...args);
            return result;
          },
        };
        for await (const message of runTools(
          [{ type: 'tool_use', id: 'skill-inline-shell', name: bash.name, input }],
          context,
          [captured],
          scope.canUseTool,
          opts.state.hookRunner,
          context.traceRecorder,
        )) {
          const failure = message.content.find(
            (block) => block.type === 'tool_result' && block.is_error,
          );
          if (failure?.type === 'tool_result')
            throw new Error(`skill inline shell failed: ${failure.content}`);
        }
        if (!result) throw new Error('skill inline shell did not execute');
        if (result.data && typeof result.data.stdout === 'string') {
          if (result.data.exit_code !== undefined && result.data.exit_code !== 0)
            throw new Error('skill inline shell failed');
          return result.data.stdout;
        }
        return bash.renderResult?.(result.data).content ?? JSON.stringify(result.data);
      },
    },
  );
  const activation: SkillActivationEnvelope = {
    name: current.name,
    revision:
      current.revision ?? createHash('sha256').update(JSON.stringify(current)).digest('hex'),
    source: opts.source,
    args: opts.args ?? '',
    allowedTools: rules ?? [],
    allowedResourceRoots: roots,
  };
  opts.state.tools = scope.tools;
  opts.state.canUseTool = scope.canUseTool;
  opts.state.restrictionCanUseTool = restrictionScope.canUseTool;
  opts.state.activations.push(activation);
  const effectiveNames = new Set(scope.tools.map((tool) => tool.name));
  opts.toolContext.parentToolPool = (opts.toolContext.parentToolPool ?? scope.tools).filter(
    (tool) => effectiveNames.has(tool.name),
  );
  opts.toolContext.canUseTool = buildToolScope({
    tools: opts.toolContext.parentToolPool,
    allowedTools: rules,
    canUseTool: opts.toolContext.canUseTool ?? scope.canUseTool,
  }).canUseTool;
  opts.toolContext.activeToolNames = scope.tools.map((tool) => tool.name);
  return { prompt, activation };
}

/** Resolve both sides before reading; lexical checks alone accept escaping links. */
export async function resolveSkillResource(
  skill: Skill,
  path: string,
  allowedRoots?: readonly string[],
): Promise<string> {
  const base = dirname(skill.realpath);
  const lexical = relative(resolve(base), resolve(base, path));
  if (
    !allowedRoots &&
    (lexical === '..' ||
      lexical.startsWith('../') ||
      lexical.startsWith('..\\') ||
      isAbsolute(lexical))
  )
    throw new Error(`skill reference path escapes skill directory: ${path}`);
  const target = await realpath(resolve(base, path));
  const roots = await Promise.all(
    (allowedRoots ?? [dirname(skill.realpath)]).map((root) => realpath(root)),
  );
  if (
    !roots.some((root) => {
      const rel = relative(root, target);
      return (
        rel === '' ||
        (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel))
      );
    })
  )
    throw new Error(`skill reference path escapes skill directory: ${path}`);
  return target;
}
