// Host-owned live skill catalogs. A manager never reads disk on its own.
import type { ToolContext } from '../tool/types.js';
import { isSkillInvocable } from './descriptor.js';
import type { SkillDiscoveryDecision } from './discovery.js';
import { type LoadSkillsOptions, loadSkills } from './loader.js';
import type { SkillRegistry, SkillSource, SkillTrustTier } from './types.js';
import { filterSkillRegistry, inferActiveToolsets } from './visibility.js';

export type SkillRegistryDiagnostic = {
  code: string;
  name?: string;
  source?: SkillSource;
  trustTier?: SkillTrustTier;
  field?: string;
  severity?: 'info' | 'warning' | 'error';
  /** Ordered scan roots; lower numbers win duplicate names. */
  precedence?: number;
  message: string;
  /** Local-only details. Never included by remoteSkillDiagnostics(). */
  path?: string;
  root?: string;
  realpath?: string;
};
export type SkillRegistryLoadResult = {
  registry: SkillRegistry;
  diagnostics?: readonly SkillRegistryDiagnostic[];
};
export type SkillRegistrySnapshot = {
  generation: number;
  registry: SkillRegistry;
  diagnostics: readonly SkillRegistryDiagnostic[];
};
export type SkillRegistryEvent = { type: 'published'; generation: number };
export type SkillRegistryManager = {
  snapshot(): SkillRegistrySnapshot;
  refresh(): Promise<SkillRegistrySnapshot>;
  subscribe(listener: (event: SkillRegistryEvent) => void): () => void;
};

function detachRegistry(registry: SkillRegistry): SkillRegistry {
  // Maps cannot be made immutable by Object.freeze(). Each reader gets its own
  // map/array and skill values, so a legacy consumer cannot corrupt publication.
  const skills = registry.skills.map((skill) => structuredClone(skill));
  return { skills, byName: new Map(skills.map((skill) => [skill.name, skill])) };
}

export function createSkillRegistryManager(opts: {
  load: () => Promise<SkillRegistryLoadResult>;
  initial?: SkillRegistryLoadResult;
}): SkillRegistryManager {
  let generation = 0;
  let refreshFailed = false;
  let current: SkillRegistryLoadResult = {
    registry: detachRegistry(opts.initial?.registry ?? { skills: [], byName: new Map() }),
    diagnostics: structuredClone(opts.initial?.diagnostics ?? []),
  };
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(event: SkillRegistryEvent) => void>();
  const snapshot = (): SkillRegistrySnapshot => ({
    generation,
    registry: detachRegistry(current.registry),
    diagnostics: [
      ...structuredClone(current.diagnostics ?? []),
      ...(refreshFailed
        ? [
            {
              code: 'refresh-failed',
              severity: 'error' as const,
              message: 'last refresh failed; previous catalog generation retained',
            },
          ]
        : []),
    ],
  });
  return {
    snapshot,
    refresh() {
      const job = tail.then(async () => {
        const next = await opts.load();
        // Build/validate the entire replacement before publishing any field.
        const registry = detachRegistry(next.registry);
        if (new Set(registry.skills.map((skill) => skill.name)).size !== registry.skills.length)
          throw new Error('skill registry loader returned duplicate names');
        current = { registry, diagnostics: structuredClone(next.diagnostics ?? []) };
        generation += 1;
        refreshFailed = false;
        for (const listener of listeners) {
          try {
            Promise.resolve(listener({ type: 'published', generation })).catch(() => undefined);
          } catch {
            /* Observers cannot roll back publication. */
          }
        }
        return snapshot();
      });
      tail = job.catch(() => {
        refreshFailed = true;
      });
      return job;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Default filesystem loader, separate from the manager's no-disk contract. */
export async function loadSkillRegistry(opts: LoadSkillsOptions): Promise<SkillRegistryLoadResult> {
  const diagnostics: SkillRegistryDiagnostic[] = [];
  const rootRanks = new Map<string, number>();
  const registry = await loadSkills({
    ...opts,
    onDiscoveryDecision(decision: SkillDiscoveryDecision) {
      const root = decision.root ?? decision.path;
      if (
        (decision.code === 'root-ready' || decision.code === 'root-missing') &&
        !rootRanks.has(root)
      )
        rootRanks.set(root, rootRanks.size);
      const precedence = rootRanks.get(root);
      const duplicateName =
        decision.code === 'duplicate-name'
          ? /duplicate skill name '([^']+)'/.exec(decision.message)?.[1]
          : undefined;
      diagnostics.push({
        ...decision,
        ...(precedence !== undefined ? { precedence } : {}),
        ...(duplicateName !== undefined ? { name: duplicateName } : {}),
      });
      opts.onDiscoveryDecision?.(decision);
    },
    warn(message) {
      diagnostics.push({
        code: message.includes('[BLOCKED:') ? 'guard-blocked' : 'loader-warning',
        severity: 'warning',
        message,
      });
      opts.warn?.(message);
    },
  });
  for (const skill of registry.skills) {
    diagnostics.push({
      code: `guard-${skill.guard.action}`,
      name: skill.name,
      source: skill.source,
      trustTier: skill.trustTier,
      severity: skill.guard.action === 'allow' ? 'info' : 'warning',
      message: `skill guard decision: ${skill.guard.action}`,
    });
    for (const diagnostic of skill.descriptor?.execution.diagnostics ?? [])
      diagnostics.push({
        ...diagnostic,
        name: skill.name,
        source: skill.source,
        trustTier: skill.trustTier,
      });
    if (!isSkillInvocable(skill, 'user'))
      diagnostics.push({
        code: 'user-invocation-disabled',
        name: skill.name,
        message: 'manual invocation is unavailable',
      });
    if (!isSkillInvocable(skill, 'model'))
      diagnostics.push({
        code: 'model-invocation-disabled',
        name: skill.name,
        message: 'model invocation is unavailable',
      });
  }
  return { registry, diagnostics };
}

/** Generation and visibility are read together for stable pagination. */
export function getSkillRegistrySnapshot(
  ctx: Pick<
    ToolContext,
    'skills' | 'skillRegistryManager' | 'skillActivation' | 'activeToolNames' | 'activeToolsets'
  >,
): SkillRegistrySnapshot {
  const snapshot = ctx.skillRegistryManager?.snapshot() ?? {
    generation: 0,
    registry: ctx.skills ?? { skills: [], byName: new Map() },
    diagnostics: [],
  };
  const names = ctx.skillActivation?.tools.map((tool) => tool.name) ?? ctx.activeToolNames;
  if (names === undefined && ctx.activeToolsets === undefined) return snapshot;
  return {
    ...snapshot,
    registry: filterSkillRegistry(
      snapshot.registry,
      names !== undefined
        ? inferActiveToolsets(names, ctx.activeToolsets)
        : (ctx.activeToolsets ?? []),
      names ?? [],
    ),
  };
}
export function getSkillRegistry(
  ctx: Pick<
    ToolContext,
    'skills' | 'skillRegistryManager' | 'skillActivation' | 'activeToolNames' | 'activeToolsets'
  >,
): SkillRegistry {
  return getSkillRegistrySnapshot(ctx).registry;
}

/** Remote diagnostics use structured, content-free fields only. Even loader
 * messages can contain paths, malformed YAML or guard findings from private files. */
export function remoteSkillDiagnostics(snapshot: SkillRegistrySnapshot) {
  return {
    generation: snapshot.generation,
    skillCount: snapshot.registry.skills.length,
    diagnostics: snapshot.diagnostics.map(
      ({ code, name, source, trustTier, field, severity, precedence }) => ({
        code,
        ...(name !== undefined ? { name } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(trustTier !== undefined ? { trustTier } : {}),
        ...(field !== undefined ? { field } : {}),
        ...(severity !== undefined ? { severity } : {}),
        ...(precedence !== undefined ? { precedence } : {}),
      }),
    ),
  };
}
