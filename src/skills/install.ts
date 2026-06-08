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
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { splitFrontmatter } from './frontmatter.js';
import {
  SkillFrontmatterSchema as LoaderSkillFrontmatterSchema,
  normalizeFrontmatterAliases,
} from './loader.js';
import { copySkillTree } from './symlinkGuard.js';
import { validateWhenToUse } from './whenToUse.js';

const SkillNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'skill name must be slash-command-safe');

const SkillFrontmatterSchema = z
  .object({
    name: SkillNameSchema,
    description: z.string().min(1),
  })
  .passthrough();

export interface InstallSkillOptions {
  /** Path to a SKILL.md file OR a directory containing one. */
  source: string;
  /** User's `<harnessHome>/skills/` root. The skill lands here. */
  userSkillsRoot: string;
  /** When true, overwrite an existing skill with the same name. */
  force?: boolean;
}

export interface InstallSkillResult {
  ok: true;
  name: string;
  installedAt: string;
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

  let frontmatterName: string;
  try {
    const raw = await readFile(skillMdPath, 'utf8');
    const fm = parseFrontmatter(raw);
    const validated = SkillFrontmatterSchema.parse(fm);
    frontmatterName = validated.name;
  } catch (err) {
    return {
      ok: false,
      reason: `invalid SKILL.md frontmatter (${skillMdPath}): ${errorMessage(err)}`,
    };
  }

  const targetDir = join(opts.userSkillsRoot, frontmatterName);
  if (existsSync(targetDir) && opts.force !== true) {
    return {
      ok: false,
      reason: `skill '${frontmatterName}' already installed at ${targetDir}. Use force:true to overwrite, or run \`/skills uninstall ${frontmatterName}\` first.`,
    };
  }

  try {
    await mkdir(opts.userSkillsRoot, { recursive: true });
    if (isDirectory) {
      // Copy the whole source directory (including reference files
      // like template.txt, examples/, etc.) into the target. copySkillTree
      // rejects out-of-tree symlinks before anything lands on disk.
      await rm(targetDir, { recursive: true, force: true });
      await copySkillTree(sourceAbs, targetDir);
    } else {
      // Single SKILL.md — wrap it in a directory of the same name.
      await mkdir(targetDir, { recursive: true });
      await cp(skillMdPath, join(targetDir, 'SKILL.md'));
    }
  } catch (err) {
    return {
      ok: false,
      reason: `failed to install to ${targetDir}: ${errorMessage(err)}`,
    };
  }

  return { ok: true, name: frontmatterName, installedAt: targetDir };
}

// ----- import (Feature A2) -----

export interface ImportSkillOptions {
  /** Path to a SKILL.md file OR a directory containing one. */
  source: string;
  /** User's `<harnessHome>/skills/` root. The skill lands here. */
  userSkillsRoot: string;
  /** When true, overwrite an existing skill with the same name. */
  force?: boolean;
}

export interface ImportSkillResult {
  ok: true;
  name: string;
  installedAt: string;
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

/** Claude Code frontmatter keys that have no harness equivalent. They are
 *  dropped from the canonical output and reported as warnings so the user
 *  knows the harness ignores them. */
const IGNORED_CC_KEYS = ['model', 'license', 'argument-hint'] as const;

/**
 * Import a Claude Code (or harness) skill, NORMALIZING its frontmatter onto
 * the harness-native canonical shape on write — distinct from `installSkill`,
 * which copies byte-faithfully. The importer:
 *   1. resolves the source (file or directory) via the shared resolver;
 *   2. parses the SKILL.md frontmatter with the real YAML parser (a justified
 *      divergence from install's name-only regex — import rewrites the WHOLE
 *      frontmatter, so it needs every key, not just `name`);
 *   3. normalizes `allowed-tools` → `allowedTools` (+ comma-string split),
 *      synthesizes `whenToUse` from `description` when absent, and records
 *      ignored CC keys (model/license/argument-hint);
 *   4. validates the normalized frontmatter against the exported loader schema
 *      (fail loud rather than land a broken skill);
 *   5. copies the whole source tree (bundled references/, scripts/), then
 *      overwrites the target SKILL.md with the canonical normalized content.
 *
 * Lands in `<userSkillsRoot>/<name>/`. A `<root>/<name>/SKILL.md` directory
 * skill is classified `community` by `classifyUserSkill` (loader.ts) — the
 * SAFER tier (blocks medium+critical guard findings), which is the intended
 * stricter posture for an untrusted third-party import. The guard scanner at
 * load is the real safety boundary regardless of tier.
 */
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
    const raw = await readFile(skillMdPath, 'utf8');
    const parts = splitFrontmatter(raw);
    rawFrontmatter = parseYaml(parts.frontmatter);
    body = parts.body;
  } catch (err) {
    return {
      ok: false,
      reason: `could not read SKILL.md (${skillMdPath}): ${errorMessage(err)}`,
    };
  }

  const normalized = normalizeImportedFrontmatter(rawFrontmatter);

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

  const targetDir = join(opts.userSkillsRoot, name);
  if (existsSync(targetDir) && opts.force !== true) {
    return {
      ok: false,
      reason: `skill '${name}' already installed at ${targetDir}. Use force:true to overwrite, or run \`/skills uninstall ${name}\` first.`,
    };
  }

  try {
    await mkdir(opts.userSkillsRoot, { recursive: true });
    // Stage the whole source tree first so bundled references/, scripts/,
    // and any other sidecar files come along, then overwrite the target
    // SKILL.md with the canonical normalized content.
    await rm(targetDir, { recursive: true, force: true });
    if (isDirectory) {
      // copySkillTree rejects out-of-tree symlinks before anything lands on disk.
      await copySkillTree(sourceAbs, targetDir);
    } else {
      await mkdir(targetDir, { recursive: true });
    }
    await writeFile(
      join(targetDir, 'SKILL.md'),
      buildCanonicalSkillFile(normalized.frontmatter, body),
    );
  } catch (err) {
    return {
      ok: false,
      reason: `failed to import to ${targetDir}: ${errorMessage(err)}`,
    };
  }

  return {
    ok: true,
    name,
    installedAt: targetDir,
    converted: normalized.converted,
    warnings: normalized.warnings,
  };
}

type NormalizedFrontmatter = {
  frontmatter: Record<string, unknown>;
  converted: string[];
  warnings: string[];
};

/** Apply the import normalizations to a parsed frontmatter object, collecting
 *  `converted`/`warnings` notes as it goes. Pure — returns a fresh object and
 *  never mutates the input.
 *
 *  F9 — the `allowed-tools` → `allowedTools` alias + comma-split is delegated to
 *  the SHARED `normalizeFrontmatterAliases` (loader.ts), the single source of
 *  that rule. This function adds ONLY the import-specific concerns on top:
 *  reporting the conversion (`converted`), dropping ignored CC keys, warning on
 *  `:`-glob Bash patterns, and synthesizing `whenToUse`.
 *
 *  Exported so tests can pin that both surfaces single-source the alias logic. */
export function normalizeImportedFrontmatter(raw: unknown): NormalizedFrontmatter {
  const converted: string[] = [];
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    // Hand the (empty) object straight to schema validation — it will reject
    // for missing name/description with a loud, specific message.
    return { frontmatter: {}, converted, warnings };
  }
  const source = raw as Record<string, unknown>;

  // 1. Apply the SHARED alias + comma-split transform (the single source of
  //    that rule). Detect whether each conversion fired by comparing the input
  //    to the transformed output so the import-specific `converted` notes stay
  //    identical to the prior hand-rolled behavior.
  const hadHyphenatedAlias =
    !('allowedTools' in source) &&
    (source as Record<string, unknown>)['allowed-tools'] !== undefined;
  const aliased = normalizeFrontmatterAliases(source) as Record<string, unknown>;
  if (hadHyphenatedAlias && 'allowedTools' in aliased) {
    converted.push('aliased Claude Code `allowed-tools` → `allowedTools`');
  }
  // The shared transform splits a string value into an array; if the post-alias
  // value is now an array where the pre-split value was a string, a split fired.
  const preSplitValue = hadHyphenatedAlias
    ? (source as Record<string, unknown>)['allowed-tools']
    : source.allowedTools;
  if (typeof preSplitValue === 'string' && Array.isArray(aliased.allowedTools)) {
    converted.push('split comma-separated `allowedTools` string into a list');
  }

  // 2. Drop every ignored CC key by omission (immutable; no `delete`). The
  //    shared transform already dropped the hyphenated `allowed-tools` key.
  //    `ignored` collects the dropped CC keys for warning reporting.
  const ignored = IGNORED_CC_KEYS.filter((key) => key in aliased);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(aliased)) {
    if ((IGNORED_CC_KEYS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }

  // Warn on CC `:`-globs in Bash(...) patterns — we do NOT auto-translate
  // (translation is lossy/ambiguous); the harness matcher uses space + `*`/`**`.
  if (Array.isArray(out.allowedTools)) {
    for (const entry of out.allowedTools) {
      if (typeof entry === 'string' && /^Bash\(.*:.*\)$/.test(entry.trim())) {
        warnings.push(
          `allowed-tools entry '${entry}' uses Claude Code ':'-glob syntax, which the harness matcher does not interpret; left verbatim — adjust to space + '*'/'**' if you want it enforced`,
        );
      }
    }
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

  // 3. report the ignored CC keys dropped above.
  for (const key of ignored) {
    warnings.push(`ignored Claude Code key '${key}' (no harness equivalent)`);
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
}

export interface UninstallSkillResult {
  ok: true;
  name: string;
  removedFrom: string;
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
  if (!existsSync(targetDir)) {
    return {
      ok: false,
      reason: `skill '${name}' is not installed at ${targetDir} (only user-scoped skills can be uninstalled — bundle and default-bundle skills are read-only).`,
    };
  }

  // Defense in depth: confirm targetDir is actually under userSkillsRoot.
  // Prevents path-traversal exploits via crafted names like '../bin'.
  const userRootAbs = resolve(opts.userSkillsRoot);
  const targetAbs = resolve(targetDir);
  if (!targetAbs.startsWith(`${userRootAbs}/`) && targetAbs !== userRootAbs) {
    return {
      ok: false,
      reason: `refusing to remove path outside user skills root: ${targetAbs}`,
    };
  }
  if (dirname(targetAbs) !== userRootAbs) {
    return {
      ok: false,
      reason: `refusing to remove nested path (uninstall operates one level under the user skills root): ${targetAbs}`,
    };
  }

  try {
    await rm(targetDir, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      reason: `failed to remove ${targetDir}: ${errorMessage(err)}`,
    };
  }
  return { ok: true, name, removedFrom: targetDir };
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
  return { name: obj.name.trim(), description: obj.description.trim() };
}
