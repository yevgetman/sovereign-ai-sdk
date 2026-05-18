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
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';

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
  const sourceAbs = resolve(opts.source);
  if (!existsSync(sourceAbs)) {
    return { ok: false, reason: `source path not found: ${sourceAbs}` };
  }

  let skillMdPath: string;
  let isDirectory: boolean;
  try {
    const st = await stat(sourceAbs);
    if (st.isDirectory()) {
      isDirectory = true;
      skillMdPath = join(sourceAbs, 'SKILL.md');
      if (!existsSync(skillMdPath)) {
        return {
          ok: false,
          reason: `directory ${sourceAbs} does not contain a SKILL.md file`,
        };
      }
    } else {
      isDirectory = false;
      skillMdPath = sourceAbs;
      if (basename(skillMdPath) !== 'SKILL.md') {
        return {
          ok: false,
          reason: `source file must be named SKILL.md (got ${basename(skillMdPath)})`,
        };
      }
    }
  } catch (err) {
    return { ok: false, reason: `could not stat ${sourceAbs}: ${errorMessage(err)}` };
  }

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
      // like template.txt, examples/, etc.) into the target.
      await rm(targetDir, { recursive: true, force: true });
      await cp(sourceAbs, targetDir, { recursive: true });
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
 * Minimal markdown frontmatter parser sufficient for SKILL.md files.
 * Mirrors the regex used by src/skills/loader.ts so install validates
 * with the same shape as the loader will eventually see.
 */
function parseFrontmatter(raw: string): unknown {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match || match[1] === undefined) {
    throw new Error('missing YAML frontmatter (expected leading --- block)');
  }
  const yamlBody = match[1];
  // We don't pull in yaml here intentionally — the loader does the
  // full parse. Just extract `name:` for the duplicate check.
  const nameMatch = yamlBody.match(/^name:\s*(.+)$/m);
  const descMatch = yamlBody.match(/^description:\s*(.+)$/m);
  if (!nameMatch || nameMatch[1] === undefined) {
    throw new Error('missing required field: name');
  }
  if (!descMatch || descMatch[1] === undefined) {
    throw new Error('missing required field: description');
  }
  return {
    name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
    description: descMatch[1].trim().replace(/^["']|["']$/g, ''),
  };
}
