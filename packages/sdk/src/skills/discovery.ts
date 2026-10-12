// Shared, bounded discovery for SDK hosts and SOV. Discovery reads directory
// metadata only; parsing and guard checks stay in the loader.
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SkillSource, SkillTrustTier } from './types.js';

export type SkillClassification = { source: SkillSource; trustTier: SkillTrustTier };
export type SkillRoot = SkillClassification & {
  path: string;
  classify?: (file: string) => SkillClassification;
  pluginRoot?: string;
};

export type SkillDiscoveryLimits = {
  maxAncestors: number;
  maxRoots: number;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export const DEFAULT_SKILL_DISCOVERY_LIMITS: Readonly<SkillDiscoveryLimits> = Object.freeze({
  maxAncestors: 64,
  maxRoots: 128,
  maxDepth: 16,
  maxEntries: 20_000,
  maxFiles: 2_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
});

export type SkillDiscoveryDecision = {
  code:
    | 'root-ready'
    | 'root-missing'
    | 'scope-denied'
    | 'broken-link'
    | 'unreadable'
    | 'cycle'
    | 'duplicate-realpath'
    | 'limit'
    | 'candidate'
    | 'load-rejected'
    | 'duplicate-name';
  path: string;
  root?: string;
  realpath?: string;
  source?: SkillSource;
  trustTier?: SkillTrustTier;
  message: string;
};

export type SkillDiscoveryOptions = {
  cwd: string;
  harnessHome: string;
  bundleRoot?: string;
  extraRoots?: SkillRoot[];
  /** Explicit project/node boundary. Must contain cwd; never widens a nearer
   * .git or .kernel boundary. Without a marker, only cwd is scanned. */
  projectRoot?: string;
  /** Host-approved external link targets, for this discovery only. Linked
   * skills retain their origin root's classification; links never grant trust. */
  allowedLinkRoots?: string[];
  discoveryLimits?: Partial<SkillDiscoveryLimits>;
  onDiscoveryDecision?: (decision: SkillDiscoveryDecision) => void;
  warn?: (message: string) => void;
};

export type DiscoveredSkillFile = {
  path: string;
  realpath: string;
  root: SkillRoot;
  classification: SkillClassification;
  size: number;
};

export type SkillDiscoveryResult = {
  projectRoot: string;
  candidates: DiscoveredSkillFile[];
  decisions: SkillDiscoveryDecision[];
  limits: SkillDiscoveryLimits;
  entriesVisited: number;
};

type ScopedRoot = { root: SkillRoot; scope: string; explicitlyContributed?: boolean };

/** Diagnostics are observers. Keep delivery synchronous, but contain both
 * synchronous exceptions and asynchronous rejection from host callbacks. */
export function observeSkillDiagnostic<T>(
  observer: ((value: T) => void) | undefined,
  value: T,
): void {
  try {
    Promise.resolve(observer?.(value)).catch(() => undefined);
  } catch {
    /* An observer cannot change discovery or catalog membership. */
  }
}

const EXCLUDED_DIRECTORIES = new Set([
  '.sov-skill-store',
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'vendor',
]);

function isSkillStoreInternal(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === '.sov-skill-store' ||
    normalized.startsWith('.sov-skill-stage-') ||
    normalized.startsWith('.sov-skill-backup-')
  );
}

export function isPathWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function resolveSkillDiscoveryLimits(
  provided: Partial<SkillDiscoveryLimits> = {},
): SkillDiscoveryLimits {
  const limits = { ...DEFAULT_SKILL_DISCOVERY_LIMITS, ...provided };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`skill discovery ${name} must be a positive safe integer`);
    }
  }
  return limits;
}

/** Nearest project wins. A nested repository or node marker stops discovery
 * even when the host supplies a larger enclosing projectRoot. */
async function projectAncestors(
  opts: SkillDiscoveryOptions,
  limits: SkillDiscoveryLimits,
  emit: (decision: SkillDiscoveryDecision) => void,
): Promise<string[]> {
  let cwd: string;
  try {
    cwd = await realpath(opts.cwd);
  } catch {
    // Preserve generic hosts with no project tree: user/plugin/bundle discovery
    // still works, and no parent of an absent cwd becomes an implicit root.
    cwd = resolve(opts.cwd);
    if (opts.projectRoot !== undefined) {
      const explicit = await realpath(opts.projectRoot);
      if (!isPathWithin(explicit, cwd)) throw new Error('skill projectRoot must contain cwd');
    }
    emit({ code: 'root-missing', path: cwd, message: 'project cwd is unavailable' });
    return [cwd];
  }
  const explicit = opts.projectRoot === undefined ? undefined : await realpath(opts.projectRoot);
  if (explicit !== undefined && !isPathWithin(explicit, cwd)) {
    throw new Error('skill projectRoot must contain cwd');
  }
  const ancestors: string[] = [];
  const isBoundary = async (path: string): Promise<boolean> => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      // An inaccessible marker cannot establish that this is the same project.
      // Stop at its directory rather than inherit an unrelated parent catalog.
      emit({ code: 'unreadable', path, message: 'project boundary marker is unavailable' });
      return true;
    }
  };
  let cursor = cwd;
  for (let depth = 0; depth < limits.maxAncestors; depth += 1) {
    ancestors.push(cursor);
    if (
      (await isBoundary(join(cursor, '.git'))) ||
      (await isBoundary(join(cursor, '.kernel', 'node.yml')))
    ) {
      return ancestors;
    }
    if (cursor === explicit) return ancestors;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // No boundary means no ambient ancestor catalog: a folder outside a project
  // must not pick up another node or a machine-wide .agents/skills directory.
  if (ancestors.length === limits.maxAncestors && cursor !== dirname(cursor)) {
    emit({ code: 'limit', path: cwd, message: 'project boundary search reached maxAncestors' });
  }
  return [cwd];
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function classifyUserSkill(file: string, root: string): SkillClassification {
  const parts = relative(root, file).split(sep);
  if (parts[0] === 'agent-created') return { source: 'agent-created', trustTier: 'agent-created' };
  if (parts[0] === 'trusted' || parts.length === 1) return { source: 'user', trustTier: 'trusted' };
  return { source: 'community', trustTier: 'community' };
}

export async function discoverSkills(opts: SkillDiscoveryOptions): Promise<SkillDiscoveryResult> {
  const limits = resolveSkillDiscoveryLimits(opts.discoveryLimits);
  const decisions: SkillDiscoveryDecision[] = [];
  const emit = (decision: SkillDiscoveryDecision): void => {
    decisions.push(decision);
    observeSkillDiagnostic(opts.onDiscoveryDecision, decision);
    if (
      !['root-ready', 'root-missing', 'candidate', 'duplicate-realpath'].includes(decision.code)
    ) {
      observeSkillDiagnostic(opts.warn, `skill skipped (${decision.path}): ${decision.message}`);
    }
  };
  const ancestors = await projectAncestors(opts, limits, emit);
  const projectRoot = ancestors[ancestors.length - 1] ?? resolve(opts.cwd);
  const roots: ScopedRoot[] = [];
  for (const ancestor of ancestors) {
    for (const host of ['.harness', '.agents']) {
      roots.push({
        root: { source: 'project', trustTier: 'trusted', path: join(ancestor, host, 'skills') },
        scope: projectRoot,
      });
    }
  }
  const userRoot = join(resolve(opts.harnessHome), 'skills');
  roots.push({
    root: {
      source: 'user',
      trustTier: 'trusted',
      path: userRoot,
      classify: (file) => classifyUserSkill(file, userRoot),
    },
    scope: resolve(opts.harnessHome),
  });
  if ((opts.extraRoots?.length ?? 0) > limits.maxRoots)
    emit({ code: 'limit', path: projectRoot, message: 'extra roots exceed maxRoots' });
  for (const root of (opts.extraRoots ?? []).slice(0, limits.maxRoots)) {
    // An extra root is an explicit host contribution; its canonical path is
    // approved, while links below it still must stay within that tree.
    roots.push({ root, scope: root.pluginRoot ?? root.path, explicitlyContributed: true });
  }
  if (opts.bundleRoot !== undefined) {
    const scope = resolve(opts.bundleRoot);
    roots.push(
      { root: { source: 'bundle', trustTier: 'builtin', path: join(scope, 'skills') }, scope },
      {
        root: {
          source: 'bundle',
          trustTier: 'trusted',
          path: join(scope, 'harness', 'skills-trusted'),
        },
        scope,
      },
      {
        root: {
          source: 'community',
          trustTier: 'community',
          path: join(scope, 'skills-community'),
        },
        scope,
      },
    );
  }
  const approvedTargets: string[] = [];
  if ((opts.allowedLinkRoots?.length ?? 0) > limits.maxRoots)
    emit({ code: 'limit', path: projectRoot, message: 'approved link roots exceed maxRoots' });
  for (const target of (opts.allowedLinkRoots ?? []).slice(0, limits.maxRoots)) {
    try {
      approvedTargets.push(await realpath(target));
    } catch {
      emit({ code: 'unreadable', path: target, message: 'approved link root is unavailable' });
    }
  }
  const candidates: DiscoveredSkillFile[] = [];
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  let entriesVisited = 0;
  let totalBytes = 0;
  let exhausted = false;

  for (const [index, { root, scope, explicitlyContributed }] of roots.entries()) {
    if (index >= limits.maxRoots) {
      emit({ code: 'limit', path: root.path, message: 'discovery reached maxRoots' });
      break;
    }
    if (exhausted) break;
    let canonicalScope: string;
    try {
      canonicalScope = await realpath(scope);
    } catch {
      emit({
        code: 'root-missing',
        path: root.path,
        root: root.path,
        message: 'skill root scope is unavailable',
      });
      continue;
    }
    const targets = [canonicalScope, ...approvedTargets];
    const event = (
      code: SkillDiscoveryDecision['code'],
      path: string,
      message: string,
      rp?: string,
    ): void => {
      emit({
        code,
        path,
        root: root.path,
        source: root.source,
        trustTier: root.trustTier,
        message,
        ...(rp === undefined ? {} : { realpath: rp }),
      });
    };
    if (explicitlyContributed) {
      try {
        const canonicalRoot = await realpath(root.path);
        // A host-selected package may itself be beneath an excluded ancestor.
        // Approve its exact tree while retaining existing containment targets
        // and exclusions for implicit descendants and private transactions.
        if (targets.some((target) => isPathWithin(target, canonicalRoot)))
          targets.push(canonicalRoot);
      } catch {
        // walk reports a missing/broken contributed root through inspect.
      }
    }
    const inspect = async (
      path: string,
    ): Promise<{ realpath: string; directory: boolean; size: number } | undefined> => {
      let rp: string;
      try {
        rp = await realpath(path);
      } catch {
        event(
          (await exists(path)) ? 'broken-link' : 'root-missing',
          path,
          'path or link target is unavailable',
        );
        return;
      }
      if (rp.split(sep).some(isSkillStoreInternal)) {
        event('scope-denied', path, 'internal skill store transactions are excluded', rp);
        return;
      }
      if (
        !targets.some(
          (target) =>
            isPathWithin(target, rp) &&
            !relative(target, rp)
              .split(sep)
              .some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase())),
        )
      ) {
        event('scope-denied', path, 'real path is outside the approved discovery scope', rp);
        return;
      }
      try {
        const info = await stat(rp);
        if (!info.isDirectory() && !info.isFile()) {
          event('unreadable', path, 'only regular files and directories are eligible', rp);
          return;
        }
        return { realpath: rp, directory: info.isDirectory(), size: info.size };
      } catch {
        event('unreadable', path, 'path metadata is unavailable', rp);
      }
    };
    const addFile = (path: string, rp: string, size: number): void => {
      if (seenFiles.has(rp)) {
        event('duplicate-realpath', path, 'file already discovered', rp);
        return;
      }
      seenFiles.add(rp);
      if (size > limits.maxFileBytes) {
        event('limit', path, 'file exceeds maxFileBytes', rp);
        return;
      }
      if (candidates.length >= limits.maxFiles || totalBytes + size > limits.maxTotalBytes) {
        event('limit', path, 'discovery reached maxFiles or maxTotalBytes', rp);
        exhausted = true;
        return;
      }
      totalBytes += size;
      candidates.push({
        path,
        realpath: rp,
        size,
        root,
        classification: root.classify?.(path) ?? root,
      });
      event('candidate', path, 'eligible skill file', rp);
    };
    const walk = async (path: string, depth: number, active: Set<string>): Promise<void> => {
      if (exhausted) return;
      const info = await inspect(path);
      if (info === undefined) return;
      if (!info.directory) {
        if (extname(path).toLowerCase() === '.md') addFile(path, info.realpath, info.size);
        return;
      }
      if (active.has(info.realpath)) {
        event('cycle', path, 'directory link cycle detected', info.realpath);
        return;
      }
      if (seenDirectories.has(info.realpath)) {
        event('duplicate-realpath', path, 'directory already discovered', info.realpath);
        return;
      }
      if (depth > limits.maxDepth) {
        event('limit', path, 'directory exceeds maxDepth', info.realpath);
        return;
      }
      seenDirectories.add(info.realpath);
      const nextActive = new Set(active).add(info.realpath);
      const entries: string[] = [];
      try {
        const handle = await opendir(info.realpath);
        for await (const entry of handle) {
          if (entriesVisited >= limits.maxEntries) {
            event('limit', path, 'discovery reached maxEntries', info.realpath);
            exhausted = true;
            break;
          }
          entriesVisited += 1;
          if (
            !(
              EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()) || isSkillStoreInternal(entry.name)
            )
          )
            entries.push(entry.name);
        }
      } catch {
        event('unreadable', path, 'directory cannot be listed', info.realpath);
        return;
      }
      entries.sort();
      const directorySkill = entries.find((name) => name.toLowerCase() === 'skill.md');
      if (directorySkill !== undefined) {
        const file = join(path, directorySkill);
        const candidate = await inspect(file);
        if (candidate !== undefined && !candidate.directory)
          addFile(file, candidate.realpath, candidate.size);
        return;
      }
      for (const name of entries) {
        if (exhausted) break;
        await walk(join(path, name), depth + 1, nextActive);
      }
    };
    event('root-ready', root.path, 'scanning approved skill root');
    await walk(root.path, 0, new Set());
  }
  return { projectRoot, candidates, decisions, limits, entriesVisited };
}
