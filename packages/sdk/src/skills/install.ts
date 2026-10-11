// Skill install/uninstall library.
//
// Drives `/skills install <path>` and `/skills uninstall <name>` from
// the TUI. Operates entirely on filesystem state under
// `<harnessHome>/skills/` — the user-scoped skills root that survives
// `sov upgrade`. Bundle and default skills are read-only here; only
// the user-scoped tree is mutable.
//
// Install accepts either:
//   - a SKILL.md file path directly
//   - a directory containing SKILL.md (and optional reference files)
//
// The skill's name comes from the SKILL.md frontmatter, NOT the source
// path or filename. Refusing to install when:
//   - the source file doesn't exist
//   - frontmatter is missing or invalid
//   - a skill with the same name already exists in the user tree
//     (caller can pass force:true to overwrite)
//
// Uninstall accepts a skill name and removes the matching
// `<harnessHome>/skills/<name>/` directory. Refuses to touch
// `agent-created/` skills, bundle skills, or default-bundle skills.

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { normalizeSkillDescriptor } from './descriptor.js';
import { splitFrontmatter } from './frontmatter.js';
import {
  SkillFrontmatterSchema as LoaderSkillFrontmatterSchema,
  normalizeFrontmatterAliases,
} from './loader.js';
import { FilesystemSkillStore, readSkillSourceFile, readSkillSourceTree } from './store.js';
import type { SkillMutationEvent, SkillStoreFile, SkillWritableStore } from './store.js';
import { validateWhenToUse } from './whenToUse.js';

const SkillNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'skill name must be slash-command-safe');

export interface InstallSkillOptions {
  /** Path to a SKILL.md file OR a directory containing one. */
  source: string;
  /** User's `<harnessHome>/skills/` root. The skill lands here. */
  userSkillsRoot: string;
  /** When true, overwrite an existing skill with the same name. */
  force?: boolean;
  /** Optional injected store; the default is the explicit userSkillsRoot. */
  store?: SkillWritableStore;
  /** When supplied, force replacement must match this tree revision. */
  expectedRevision?: string;
}

export interface InstallSkillResult {
  ok: true;
  name: string;
  installedAt: string;
  revision: string;
  event: SkillMutationEvent;
}

export interface InstallSkillError {
  ok: false;
  reason: string;
}

export type InstallResult = InstallSkillResult | InstallSkillError;

/**
 * Install a skill from a local path into `<userSkillsRoot>/<name>/`.
 * Returns a discriminated result so the caller can render a user-
 * facing message without throwing.
 */
export async function installSkill(opts: InstallSkillOptions): Promise<InstallResult> {
  const resolved = await resolveSkillSource(opts.source);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }
  const { sourceAbs, skillMdPath, isDirectory } = resolved;

  try {
    const raw = Buffer.from(await readSkillSourceFile(skillMdPath)).toString('utf8');
    const validated = LoaderSkillFrontmatterSchema.parse(parseFrontmatter(raw));
    const tree = await captureSource(sourceAbs, skillMdPath, isDirectory);
    const committed = await publishTree(opts, validated.name, tree);
    return {
      ok: true,
      name: validated.name,
      installedAt: join(opts.userSkillsRoot, validated.name),
      revision: committed.revision,
      event: committed.event,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `invalid SKILL.md frontmatter or failed install (${skillMdPath}): ${errorMessage(err)}`,
    };
  }
}

// ----- import (Feature A2) -----

export interface ImportSkillOptions {
  /** Path to a SKILL.md file OR a directory containing one. */
  source: string;
  /** User's `<harnessHome>/skills/` root. The skill lands here. */
  userSkillsRoot: string;
  /** When true, overwrite an existing skill with the same name. */
  force?: boolean;
  /** Optional injected store; the default is the explicit userSkillsRoot. */
  store?: SkillWritableStore;
  /** When supplied, force replacement must match this tree revision. */
  expectedRevision?: string;
}

export interface ImportSkillResult {
  ok: true;
  name: string;
  installedAt: string;
  revision: string;
  event: SkillMutationEvent;
  /** Human-readable notes about each normalization the importer applied
   *  (e.g. the `allowed-tools` → `allowedTools` rewrite). */
  converted: string[];
  /** Non-fatal advisories (ignored Claude Code keys, `:`-glob Bash
   *  patterns the harness matcher won't interpret, etc.). */
  warnings: string[];
}

export interface ImportSkillError {
  ok: false;
  reason: string;
}

export type ImportResult = ImportSkillResult | ImportSkillError;

/** Import portable skills without changing the meaning of tool policy or
 * dropping vendor fields. Unsupported execution controls remain visible and
 * inert until activation, which refuses them with diagnostics. */
export async function importSkill(opts: ImportSkillOptions): Promise<ImportResult> {
  const resolved = await resolveSkillSource(opts.source);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }
  const { sourceAbs, skillMdPath, isDirectory } = resolved;

  // Parse with the real YAML parser — import rewrites the whole frontmatter,
  // so it needs the full key/value map, not just `name` (unlike install's
  // name-only regex).
  let rawFrontmatter: unknown;
  let body: string;
  try {
    const raw = Buffer.from(await readSkillSourceFile(skillMdPath)).toString('utf8');
    const parts = splitFrontmatter(raw);
    rawFrontmatter = parseYaml(parts.frontmatter);
    body = parts.body;
  } catch (err) {
    return {
      ok: false,
      reason: `could not read SKILL.md (${skillMdPath}): ${errorMessage(err)}`,
    };
  }

  let normalized: NormalizedFrontmatter;
  try {
    normalized = normalizeImportedFrontmatter(rawFrontmatter);
  } catch (err) {
    return { ok: false, reason: `invalid skill controls: ${errorMessage(err)}` };
  }

  // Validate against the loader's schema BEFORE landing anything on disk —
  // fail loud so a broken import never produces an unloadable skill.
  const validated = LoaderSkillFrontmatterSchema.safeParse(normalized.frontmatter);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: `normalized frontmatter is invalid: ${issues}` };
  }
  const name = (validated.data as { name: string }).name;

  try {
    const tree = await captureSource(sourceAbs, skillMdPath, isDirectory);
    const files = new Map(tree.files);
    files.set('SKILL.md', {
      data: Buffer.from(buildCanonicalSkillFile(normalized.frontmatter, body)),
      mode: files.get('SKILL.md')?.mode ?? 0o600,
    });
    const committed = await publishTree(opts, name, { ...tree, files });
    return {
      ok: true,
      name,
      installedAt: join(opts.userSkillsRoot, name),
      revision: committed.revision,
      event: committed.event,
      converted: normalized.converted,
      warnings: normalized.warnings,
    };
  } catch (err) {
    return { ok: false, reason: `failed to import skill '${name}': ${errorMessage(err)}` };
  }
}

type NormalizedFrontmatter = {
  frontmatter: Record<string, unknown>;
  converted: string[];
  warnings: string[];
};

/** Shared loader normalization plus import diagnostics and trigger synthesis.
 * Portable pre-approval requests remain requests; they do not bypass host policy. */
export function normalizeImportedFrontmatter(raw: unknown): NormalizedFrontmatter {
  const converted: string[] = [];
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    // Hand the (empty) object straight to schema validation — it will reject
    // for missing name/description with a loud, specific message.
    return { frontmatter: {}, converted, warnings };
  }
  const source = raw as Record<string, unknown>;

  const out = normalizeFrontmatterAliases(source) as Record<string, unknown>;
  const descriptor = normalizeSkillDescriptor(out);
  warnings.push(...descriptor.execution.diagnostics.map((entry) => entry.message));
  if (typeof source['allowed-tools'] === 'string')
    converted.push(
      'parsed portable `allowed-tools` comma/whitespace list without changing its meaning',
    );
  if (typeof source.allowedTools === 'string')
    converted.push('split native comma-separated `allowedTools` string into a list');
  for (const entry of descriptor.toolPolicy.preapprovedTools) {
    if (/^Bash\(.*:.*\)$/.test(entry))
      warnings.push(
        `portable allowed-tools entry '${entry}' uses Claude ':'-glob syntax; preserved without a SOV permission grant`,
      );
  }

  // 2. synthesize whenToUse from description when absent so the import loads
  //    cleanly (avoids the validateWhenToUse "reads like a preamble" warning).
  //    If the description already reads as a trigger predicate, reuse it
  //    verbatim; otherwise frame it with a trigger verb so the synthesized
  //    value passes the load-time rigor heuristic.
  const hasWhenToUse = typeof out.whenToUse === 'string' && out.whenToUse.trim().length > 0;
  if (!hasWhenToUse && typeof out.description === 'string' && out.description.trim().length > 0) {
    const desc = out.description.trim();
    out.whenToUse = validateWhenToUse(desc).ok
      ? desc
      : `User asks for help with ${lowerFirst(desc)}`;
    converted.push('synthesized `whenToUse` from `description`');
  }

  return { frontmatter: out, converted, warnings };
}

/** Build a canonical SKILL.md string: a YAML frontmatter block followed by the
 *  original body. Mirrors the `---\n<yaml>---\n<body>` convention used by
 *  SkillProposeTool / SkillManageTool. */
function buildCanonicalSkillFile(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(frontmatter);
  const trimmedBody = body.replace(/^\n+/, '');
  return `---\n${yaml}---\n\n${trimmedBody}`;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]?.toLowerCase() + text.slice(1) : text;
}

type ResolvedSource =
  | { ok: true; sourceAbs: string; skillMdPath: string; isDirectory: boolean }
  | { ok: false; reason: string };

/** Resolve a skill source path to its SKILL.md, shared by install + import.
 *  Accepts a SKILL.md file directly or a directory containing one. */
async function resolveSkillSource(source: string): Promise<ResolvedSource> {
  const sourceAbs = resolve(source);
  if (!existsSync(sourceAbs)) {
    return { ok: false, reason: `source path not found: ${sourceAbs}` };
  }
  try {
    const st = await stat(sourceAbs);
    if (st.isDirectory()) {
      const skillMdPath = join(sourceAbs, 'SKILL.md');
      if (!existsSync(skillMdPath)) {
        return { ok: false, reason: `directory ${sourceAbs} does not contain a SKILL.md file` };
      }
      return { ok: true, sourceAbs, skillMdPath, isDirectory: true };
    }
    if (basename(sourceAbs) !== 'SKILL.md') {
      return {
        ok: false,
        reason: `source file must be named SKILL.md (got ${basename(sourceAbs)})`,
      };
    }
    return { ok: true, sourceAbs, skillMdPath: sourceAbs, isDirectory: false };
  } catch (err) {
    return { ok: false, reason: `could not stat ${sourceAbs}: ${errorMessage(err)}` };
  }
}

export interface UninstallSkillOptions {
  /** Skill name as it appears in slash dispatch (e.g., 'my-skill'). */
  name: string;
  /** User's `<harnessHome>/skills/` root. Uninstall only touches this. */
  userSkillsRoot: string;
  store?: SkillWritableStore;
  expectedRevision?: string;
}

export interface UninstallSkillResult {
  ok: true;
  name: string;
  removedFrom: string;
  event: SkillMutationEvent;
}

export interface UninstallSkillError {
  ok: false;
  reason: string;
}

export type UninstallResult = UninstallSkillResult | UninstallSkillError;

/**
 * Uninstall a user-installed skill by name. Only removes the
 * `<userSkillsRoot>/<name>/` directory — refuses to touch
 * `agent-created/`, bundle skills, or default-bundle skills.
 */
export async function uninstallSkill(opts: UninstallSkillOptions): Promise<UninstallResult> {
  const parsed = SkillNameSchema.safeParse(opts.name);
  if (!parsed.success) {
    return { ok: false, reason: `invalid skill name: ${opts.name}` };
  }
  const name = parsed.data;

  const targetDir = join(opts.userSkillsRoot, name);
  try {
    const store =
      opts.store ?? new FilesystemSkillStore({ root: opts.userSkillsRoot, trustTier: 'community' });
    const previous = await store.read(name);
    if (!previous)
      return {
        ok: false,
        reason: `skill '${name}' is not installed at ${targetDir} (only user-scoped skills can be uninstalled)`,
      };
    const result = await store.mutate({
      action: 'delete',
      name,
      expectedRevision: opts.expectedRevision ?? previous.revision,
    });
    return { ok: true, name, removedFrom: targetDir, event: result.event };
  } catch (err) {
    return { ok: false, reason: `failed to remove ${targetDir}: ${errorMessage(err)}` };
  }
}

// ----- internal helpers -----

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Parse a SKILL.md's frontmatter with the REAL YAML parser, so install's
 * duplicate-check + landed-directory name match exactly what the loader (and
 * import) register (F10). A bespoke line-regex disagreed with YAML on quoted
 * values and inline comments — e.g. `name: my-skill # note` scraped to the
 * literal `my-skill # note` (an invalid name), while YAML yields `my-skill`.
 * Reuses the shared (CRLF-tolerant) frontmatter splitter so install sees the
 * same shape as the loader.
 */
function parseFrontmatter(raw: string): unknown {
  const { frontmatter: yamlBody } = splitFrontmatter(raw);
  const parsed = parseYaml(yamlBody);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('missing required field: name');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    throw new Error('missing required field: name');
  }
  if (typeof obj.description !== 'string' || obj.description.trim().length === 0) {
    throw new Error('missing required field: description');
  }
  return obj;
}

async function captureSource(
  source: string,
  skillPath: string,
  directory: boolean,
): Promise<{
  files: ReadonlyMap<string, SkillStoreFile>;
  directoryModes: ReadonlyMap<string, number>;
}> {
  if (directory) return await readSkillSourceTree(source);
  const info = await stat(skillPath);
  return {
    files: new Map([
      ['SKILL.md', { data: await readSkillSourceFile(skillPath), mode: info.mode & 0o777 }],
    ]),
    directoryModes: new Map([['', 0o700]]),
  };
}

async function publishTree(
  opts: InstallSkillOptions,
  name: string,
  tree: { files: ReadonlyMap<string, SkillStoreFile>; directoryModes: ReadonlyMap<string, number> },
): Promise<{ revision: string; event: SkillMutationEvent }> {
  const store =
    opts.store ?? new FilesystemSkillStore({ root: opts.userSkillsRoot, trustTier: 'community' });
  const previous = await store.read(name);
  if (previous && !opts.force)
    throw new Error(`skill '${name}' already installed. Use force:true to overwrite.`);
  const result = await store.mutate({
    action: previous ? 'edit' : 'create',
    name,
    ...tree,
    ...(previous ? { expectedRevision: opts.expectedRevision ?? previous.revision } : {}),
  });
  if (!result.entry) throw new Error('skill transaction returned no committed entry');
  return { revision: result.entry.revision, event: result.event };
}
