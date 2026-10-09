import { isDeepStrictEqual } from 'node:util';
import type { CanUseTool } from '../permissions/types.js';
import { defaultMaxTurns, filterToolsForToolset, isToolsetName } from './toolset.js';

/** Named explicit tool membership. A profile selects tools; it grants no permission. */
export type ToolCapabilityProfile = {
  name: string;
  tools: readonly string[];
  maxTurns?: number;
};

export class CapabilityProfileRegistry {
  private readonly profiles = new Map<string, ToolCapabilityProfile>();

  constructor(profiles: readonly ToolCapabilityProfile[] = []) {
    for (const profile of profiles) {
      if (!profile.name.trim() || isToolsetName(profile.name) || this.profiles.has(profile.name)) {
        throw new Error(`invalid or duplicate capability profile: ${profile.name}`);
      }
      if (
        profile.maxTurns !== undefined &&
        (!Number.isInteger(profile.maxTurns) || profile.maxTurns < 1)
      ) {
        throw new Error('profile maxTurns must be a positive integer');
      }
      this.profiles.set(profile.name, { ...profile, tools: [...profile.tools] });
    }
  }

  has(name: string): boolean {
    return isToolsetName(name) || this.profiles.has(name);
  }

  maxTurns(name: string): number {
    if (isToolsetName(name)) return defaultMaxTurns(name);
    const profile = this.profiles.get(name);
    if (!profile) throw new Error(`unknown capability profile: ${name}`);
    return profile.maxTurns ?? 100;
  }

  filter<T extends { name: string }>(name: string, pool: readonly T[], parent?: string): T[] {
    const inherited = parent !== undefined ? this.filter(parent, pool) : pool;
    if (isToolsetName(name)) return filterToolsForToolset(inherited, name);
    const profile = this.profiles.get(name);
    if (!profile) throw new Error(`unknown capability profile: ${name}`);
    const allowed = new Set(profile.tools);
    return inherited.filter((tool) => allowed.has(tool.name));
  }
}

/** Intersect two authorization decisions. A child may deny but cannot grant over its parent. */
export function intersectCanUseTool(parent: CanUseTool | undefined, child: CanUseTool): CanUseTool {
  return async (tool, input, ctx) => {
    const inherited = {
      ...(parent ? await parent(tool, input, ctx) : { behavior: 'allow' as const }),
    };
    if (inherited.behavior === 'deny') return inherited;
    // Snapshot approval before awaiting child policy; host-owned objects may be reused.
    const authorized = structuredClone(
      inherited.updatedInput !== undefined ? inherited.updatedInput : input,
    );
    const narrowed = await child(tool, structuredClone(authorized), ctx);
    if (narrowed.behavior === 'deny') return narrowed;
    // Narrowing policies must not rewrite the already-authorized parent input.
    if (narrowed.updatedInput !== undefined) {
      return { behavior: 'deny', reason: 'child narrowing policy cannot rewrite inputs' };
    }
    if (inherited.updatedInput !== undefined) return { ...inherited, updatedInput: authorized };
    // Do not label already-parsed input a rewrite: that would apply Zod transforms twice.
    if (!isDeepStrictEqual(input, authorized)) {
      return { behavior: 'deny', reason: 'parent-authorized input changed during child policy' };
    }
    return inherited;
  };
}
