// Optional, host-owned skill composition. Importing or constructing this
// interface never chooses a home directory, opens a store or reads disk.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { ToolContext } from '../tool/types.js';
import {
  type SkillActivationEnvelope,
  type SkillActivationSource,
  type SkillActivationState,
  activateSkill,
  resolveSkillResource,
} from './activation.js';
import { DEFAULT_SKILL_DISCOVERY_LIMITS } from './discovery.js';
import { guardSkillText } from './guard.js';
import {
  type LoadSkillsOptions,
  type SkillClassification,
  loadSkillText,
  reloadSkill,
} from './loader.js';
import {
  type SkillRegistryLoadResult,
  type SkillRegistryManager,
  type SkillRegistrySnapshot,
  createSkillRegistryManager,
  getSkillRegistry,
  loadSkillRegistry,
} from './registry.js';
import type {
  SkillMutation,
  SkillMutationEvent,
  SkillMutationResult,
  SkillStoredEntry,
  SkillWritableStore,
} from './storeTypes.js';
import { SKILL_STORE_LIMITS, assertSkillStoreResource } from './storeValidation.js';
import type { Skill } from './types.js';

export type SkillRuntimeEvent =
  | { type: 'refreshed'; generation: number }
  | { type: 'mutation'; event: SkillMutationEvent }
  | { type: 'error'; operation: 'refresh' | 'inspect' | 'activate' | 'mutate'; error: unknown };

export type SkillRuntimeInspection = {
  skill: Skill;
  path: string;
  content: string;
  /** Trusted opaque resource target identity. No disk lookup required by consumers. */
  resourceIdentity?: string;
};
export type SkillRuntimeActivationOptions = {
  source: SkillActivationSource;
  args?: string;
  toolContext: ToolContext;
  state: SkillActivationState;
};

export type SkillRuntime = {
  readonly manager: SkillRegistryManager;
  readonly store?: SkillWritableStore;
  snapshot(): SkillRegistrySnapshot;
  /** Discover and publish a new complete generation. Explicit and asynchronous. */
  discover(): Promise<SkillRegistrySnapshot>;
  refresh(): Promise<SkillRegistrySnapshot>;
  inspect(name: string, path?: string): Promise<SkillRuntimeInspection>;
  activate(
    name: string,
    options: SkillRuntimeActivationOptions,
  ): Promise<{ prompt: string; activation: SkillActivationEnvelope }>;
  mutate(change: SkillMutation): Promise<SkillMutationResult>;
  /** Awaited by tools after a committed store mutation. */
  onMutation(event: SkillMutationEvent): Promise<void>;
  /** Bind this profile to a copy of a host context; permission fields stay intact. */
  bindContext(context: ToolContext): ToolContext;
  subscribe(listener: (event: SkillRuntimeEvent) => void): () => void;
  dispose(): void;
};

export type SkillRuntimeOptions = {
  /** Supply an existing manager, a loader, discovery options or a store-only catalog. */
  manager?: SkillRegistryManager;
  load?: () => Promise<SkillRegistryLoadResult>;
  discovery?: LoadSkillsOptions;
  store?: SkillWritableStore;
  initial?: SkillRegistryLoadResult;
  /** Classification is host policy, never frontmatter authority. */
  storeClassification?: SkillClassification;
  /** Required for virtual host catalogs that are not backed by the supplied store. */
  resolveSkill?: (skill: Skill) => Promise<Skill>;
  readResource?: (skill: Skill, path: string) => Promise<string>;
  allowedResourceRoots?: (skill: Skill) => Promise<readonly string[] | undefined>;
  storeDiscoveryLimits?: { maxEntries?: number; maxBytes?: number };
};

const MEMORY_CLASSIFICATION: SkillClassification = {
  source: 'agent-created',
  trustTier: 'agent-created',
};

/** Pure composition over the shared registry, descriptor, activation and store
 * contracts. createAgent opts into it; the minimal agent stays disk-free. */
export function createSkillRuntime(options: SkillRuntimeOptions): SkillRuntime {
  const choices =
    Number(options.manager !== undefined) +
    Number(options.load !== undefined) +
    Number(options.discovery !== undefined);
  if (choices > 1) throw new Error('choose one skill manager, loader or discovery configuration');
  if (choices === 0 && !options.store)
    throw new Error(
      'an explicit skill loader, manager, discovery configuration or store is required',
    );
  if (options.manager && options.initial)
    throw new Error('initial belongs to a newly composed skill registry manager');
  const storeOnly = choices === 0;
  const classification = options.storeClassification ?? MEMORY_CLASSIFICATION;
  const discovery = options.discovery
    ? { mode: 'metadata' as const, ...options.discovery }
    : undefined;
  const store = options.store;
  const load =
    options.load ??
    (discovery
      ? () => loadSkillRegistry(discovery)
      : async () => {
          if (!store) throw new Error('an explicit skill store is required');
          return loadStoreCatalog(store, classification, options.storeDiscoveryLimits);
        });
  const manager =
    options.manager ??
    createSkillRegistryManager({ load, ...(options.initial ? { initial: options.initial } : {}) });
  const listeners = new Set<(event: SkillRuntimeEvent) => void>();
  const boundMutationHandlers = new WeakSet<NonNullable<ToolContext['onSkillMutation']>>();
  const pendingMutations = new Map<string, number>();
  let disposed = false;
  const emit = (event: SkillRuntimeEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* Observers cannot roll back a commit. */
      }
    }
  };
  const checkOpen = () => {
    if (disposed) throw new Error('skill runtime is disposed');
  };
  const run = async <T>(
    operation: 'refresh' | 'inspect' | 'activate' | 'mutate',
    fn: () => Promise<T>,
  ): Promise<T> => {
    checkOpen();
    try {
      return await fn();
    } catch (error) {
      emit({ type: 'error', operation, error });
      throw error;
    }
  };
  const refresh = () => run('refresh', () => manager.refresh());
  const resolveCurrent = async (skill: Skill) => {
    if (options.resolveSkill) return options.resolveSkill(skill);
    if (!storeOnly) return reloadSkill(skill);
    const entry = await options.store?.read(skill.name);
    if (!entry) throw new Error(`skill '${skill.name}' no longer exists`);
    return skillFromEntry(entry, classification);
  };
  const stopManager = manager.subscribe(({ generation }) =>
    emit({ type: 'refreshed', generation }),
  );
  const mutationKey = (event: SkillMutationEvent) =>
    JSON.stringify([
      event.action,
      event.name,
      event.revision ?? null,
      event.previousRevision ?? null,
      event.path ?? null,
    ]);
  const publishMutation = (event: SkillMutationEvent) => {
    const key = mutationKey(event);
    const pending = pendingMutations.get(key) ?? 0;
    if (pending > 0) {
      if (pending === 1) pendingMutations.delete(key);
      else pendingMutations.set(key, pending - 1);
    } else emit({ type: 'mutation', event: { ...event } });
  };
  let stopStore: (() => void) | undefined;
  try {
    stopStore = options.store?.subscribe((event) => {
      emit({ type: 'mutation', event: { ...event } });
      const key = mutationKey(event);
      pendingMutations.set(key, (pendingMutations.get(key) ?? 0) + 1);
      if (pendingMutations.size > 64) {
        const oldest = pendingMutations.keys().next().value;
        if (oldest !== undefined) pendingMutations.delete(oldest);
      }
    });
  } catch (error) {
    stopManager();
    throw error;
  }
  const runtime: SkillRuntime = {
    manager,
    ...(options.store ? { store: options.store } : {}),
    snapshot: () => manager.snapshot(),
    discover: refresh,
    refresh,
    inspect(name, path) {
      return run('inspect', async () => {
        const cached = manager.snapshot().registry.byName.get(name);
        if (!cached) throw new Error(`unknown skill '${name}'`);
        const entry = storeOnly ? await options.store?.read(name) : undefined;
        if (storeOnly && !entry) throw new Error(`skill '${name}' no longer exists`);
        const skill = entry ? skillFromEntry(entry, classification) : await resolveCurrent(cached);
        if (!path || path === 'SKILL.md') return { skill, path: 'SKILL.md', content: skill.body };
        assertSkillStoreResource(path);
        let content: string;
        let resourceIdentity = createHash('sha256')
          .update(JSON.stringify([skill.realpath, path]))
          .digest('hex');
        if (options.readResource) content = await options.readResource(skill, path);
        else if (storeOnly) {
          const file = entry?.files.get(path);
          if (!file) throw new Error(`skill resource '${path}' does not exist`);
          if (file.data.byteLength > SKILL_STORE_LIMITS.bytes)
            throw new Error('skill resource exceeds byte limit');
          content = new TextDecoder().decode(file.data);
        } else {
          const target = await resolveSkillResource(
            skill,
            path,
            await options.allowedResourceRoots?.(skill),
          );
          resourceIdentity = createHash('sha256').update(target).digest('hex');
          content = await readBoundedResource(
            skill,
            path,
            target,
            await options.allowedResourceRoots?.(skill),
          );
        }
        return { skill, path, content, resourceIdentity };
      });
    },
    activate(name, activationOptions) {
      return run('activate', async () => {
        const context = { ...activationOptions.toolContext, skillRegistryManager: manager };
        const skill = getSkillRegistry(context).byName.get(name);
        if (!skill) throw new Error(`unknown or unavailable skill '${name}'`);
        const virtual = storeOnly && skill.path.startsWith('skill-store:/');
        const roots = options.allowedResourceRoots
          ? await options.allowedResourceRoots(skill)
          : virtual
            ? []
            : undefined;
        return activateSkill(skill, {
          ...activationOptions,
          resolveSkill: resolveCurrent,
          ...(roots !== undefined ? { allowedResourceRoots: roots } : {}),
          ...(virtual ? { executionDirectory: activationOptions.toolContext.cwd } : {}),
        });
      });
    },
    mutate(change) {
      return run('mutate', async () => {
        if (!options.store) throw new Error('this skill runtime has no writable store');
        const result = await options.store.mutate(change);
        publishMutation(result.event);
        // Publication failures do not misreport an already committed mutation
        // as a failed write. They are explicit error events and discover retry.
        try {
          await refresh();
        } catch {
          /* refresh emitted the diagnostic */
        }
        return result;
      });
    },
    async onMutation(event) {
      publishMutation(event);
      await refresh();
    },
    bindContext(context) {
      checkOpen();
      const previous =
        context.skillRuntime && context.skillRuntime !== runtime
          ? undefined
          : context.onSkillMutation;
      const { skillStore: _previousStore, onSkillMutation: _previousMutation, ...base } = context;
      const onSkillMutation =
        previous && boundMutationHandlers.has(previous)
          ? previous
          : async (event: SkillMutationEvent) => {
              await runtime.onMutation(event);
              if (previous) await previous(event);
            };
      boundMutationHandlers.add(onSkillMutation);
      return {
        ...base,
        skills: manager.snapshot().registry,
        skillRegistryManager: manager,
        skillRuntime: runtime,
        ...(options.store ? { skillStore: options.store } : {}),
        onSkillMutation,
      };
    },
    subscribe(listener) {
      checkOpen();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopManager();
      stopStore?.();
      listeners.clear();
      pendingMutations.clear();
    },
  };
  return runtime;
}

function skillFromEntry(entry: SkillStoredEntry, classification: SkillClassification): Skill {
  if (entry.files.size > SKILL_STORE_LIMITS.files) throw new Error('skill tree exceeds file limit');
  let bytes = Buffer.byteLength(entry.content);
  if (bytes > DEFAULT_SKILL_DISCOVERY_LIMITS.maxFileBytes)
    throw new Error('skill body exceeds the bounded file limit');
  if (bytes > SKILL_STORE_LIMITS.bytes) throw new Error('skill tree exceeds byte limit');
  const guard = guardSkillText(entry.content, classification.trustTier);
  const rank = { allow: 0, ask: 1, block: 2 };
  for (const [path, file] of entry.files) {
    assertSkillStoreResource(path);
    if (file.data.byteLength > DEFAULT_SKILL_DISCOVERY_LIMITS.maxFileBytes)
      throw new Error('skill resource exceeds the bounded file limit');
    if (path === 'SKILL.md') continue;
    bytes += file.data.byteLength;
    if (bytes > SKILL_STORE_LIMITS.bytes) throw new Error('skill tree exceeds byte limit');
    const resourceGuard = guardSkillText(
      new TextDecoder().decode(file.data),
      classification.trustTier,
    );
    guard.findings.push(...resourceGuard.findings.map((finding) => ({ ...finding, file: path })));
    if (rank[resourceGuard.action] > rank[guard.action]) guard.action = resourceGuard.action;
  }
  const skill = loadSkillText(entry.content, {
    ...classification,
    path: entry.path ?? `skill-store:/${entry.name}/SKILL.md`,
    guard,
  });
  if (skill.name !== entry.name) throw new Error('skill store identity does not match frontmatter');
  return skill;
}

async function loadStoreCatalog(
  store: SkillWritableStore,
  classification: SkillClassification,
  limits?: SkillRuntimeOptions['storeDiscoveryLimits'],
): Promise<SkillRegistryLoadResult> {
  const maxEntries = limits?.maxEntries ?? 10_000;
  const maxBytes = limits?.maxBytes ?? SKILL_STORE_LIMITS.bytes;
  if (![maxEntries, maxBytes].every((limit) => Number.isSafeInteger(limit) && limit > 0))
    throw new Error('skill store discovery limits must be positive integers');
  const skills: Skill[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let generation: string | undefined;
  let bytes = 0;
  do {
    const page = await store.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    if (generation !== undefined && page.generation !== generation)
      throw new Error('skill store changed during discovery; retry');
    generation = page.generation;
    for (const name of page.names) {
      if (seen.has(name)) throw new Error('skill store returned duplicate catalog identities');
      seen.add(name);
      if (seen.size > maxEntries)
        throw new Error('skill store catalog exceeds the bounded discovery limit');
      const entry = await store.read(name);
      if (!entry) throw new Error('skill store changed during discovery; retry');
      bytes +=
        Buffer.byteLength(entry.content) +
        [...entry.files].reduce(
          (total, [path, file]) => total + (path === 'SKILL.md' ? 0 : file.data.byteLength),
          0,
        );
      if (bytes > maxBytes) throw new Error('skill store catalog exceeds the bounded byte limit');
      const skill = skillFromEntry(entry, classification);
      if (skill.name !== name) throw new Error('skill store identity does not match frontmatter');
      skills.push(skill);
    }
    if (page.truncated && (!page.nextCursor || page.nextCursor === cursor))
      throw new Error('skill store returned a stalled pagination cursor');
    cursor = page.truncated ? page.nextCursor : undefined;
  } while (cursor);
  // Membership can change while the last page's bodies are read. Verify the
  // names generation again before publishing a complete catalog. Each body
  // retains its own tree revision; this is not a cross-skill transaction.
  const finalPage = await store.list({ limit: 1 });
  if (finalPage.generation !== generation)
    throw new Error('skill store changed during discovery; retry');
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { registry: { skills, byName: new Map(skills.map((skill) => [skill.name, skill])) } };
}

async function readBoundedResource(
  skill: Skill,
  path: string,
  target: string,
  roots?: readonly string[],
): Promise<string> {
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > SKILL_STORE_LIMITS.bytes)
      throw new Error('skill resource is not a bounded regular file');
    const buffer = Buffer.alloc(SKILL_STORE_LIMITS.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > SKILL_STORE_LIMITS.bytes) throw new Error('skill resource exceeds byte limit');
    const current = await stat(target);
    if (
      (await realpath(target)) !== target ||
      (await resolveSkillResource(skill, path, roots)) !== target ||
      current.ino !== info.ino ||
      current.dev !== info.dev
    )
      throw new Error('skill resource changed during read');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}
