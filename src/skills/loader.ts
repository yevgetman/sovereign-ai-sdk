// Skill loader and prompt expansion. Scans user/project/bundle skill
// directories, parses markdown frontmatter, and lazily expands skill bodies
// when a slash command or SkillTool invokes one.

import { existsSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { formatGuardBlockMessage, guardSkillLoad } from './guard.js';
import type {
  Skill,
  SkillExpansionOptions,
  SkillHarnessMetadata,
  SkillRegistry,
  SkillSource,
  SkillTrustTier,
} from './types.js';
import { validateWhenToUse } from './whenToUse.js';

const MetadataHarnessSchema = z
  .object({
    requires_toolsets: z.array(z.string()).default([]),
    requires_tools: z.array(z.string()).default([]),
    fallback_for_toolsets: z.array(z.string()).default([]),
    fallback_for_tools: z.array(z.string()).default([]),
  })
  .default({});

const MetadataSchema = z
  .object({
    harness: MetadataHarnessSchema,
  })
  .default({});

const SkillFrontmatterSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'must be a slash-command-safe name'),
    description: z.string().min(1),
    allowedTools: z.array(z.string()).default([]),
    whenToUse: z.string().default(''),
    metadata: MetadataSchema,
  })
  .passthrough();

const SHELL_INTERPOLATION_RE = /(?:`!([^`]+)`|!`([^`]+)`)/g;
const SHELL_TIMEOUT_MS = 10_000;
const SHELL_OUTPUT_CAP = 16 * 1024;

export type LoadSkillsOptions = {
  harnessHome: string;
  cwd: string;
  /** When set, scans bundle-relative skill roots; absent in generic-agent mode. */
  bundleRoot?: string;
  warn?: (message: string) => void;
};

type SkillClassification = {
  source: SkillSource;
  trustTier: SkillTrustTier;
};

type SkillRoot = SkillClassification & {
  path: string;
  classify?: (file: string) => SkillClassification;
};

export async function loadSkills(opts: LoadSkillsOptions): Promise<SkillRegistry> {
  const roots: SkillRoot[] = [
    {
      source: 'project',
      trustTier: 'trusted',
      path: join(opts.cwd, '.harness', 'skills'),
    },
    {
      source: 'user',
      trustTier: 'trusted',
      path: join(opts.harnessHome, 'skills'),
      classify: (file) => classifyUserSkill(file, join(opts.harnessHome, 'skills')),
    },
  ];
  if (opts.bundleRoot !== undefined) {
    roots.push(
      { source: 'bundle', trustTier: 'builtin', path: join(opts.bundleRoot, 'skills') },
      {
        source: 'bundle',
        trustTier: 'trusted',
        path: join(opts.bundleRoot, 'harness', 'skills-trusted'),
      },
      {
        source: 'community',
        trustTier: 'community',
        path: join(opts.bundleRoot, 'skills-community'),
      },
    );
  }

  const seenRealpaths = new Set<string>();
  const byName = new Map<string, Skill>();
  const skills: Skill[] = [];

  for (const root of roots) {
    for (const file of await listMarkdownFiles(root.path)) {
      let rp: string;
      try {
        rp = await realpath(file);
      } catch (err) {
        opts.warn?.(`skill skipped (${file}): ${errorMessage(err)}`);
        continue;
      }
      if (seenRealpaths.has(rp)) continue;
      seenRealpaths.add(rp);

      const classification = root.classify?.(file) ?? root;
      const loaded = await loadSkillFile(file, rp, classification, opts.warn);
      if (!loaded) continue;
      if (byName.has(loaded.name)) {
        opts.warn?.(`skill skipped (${file}): duplicate skill name '${loaded.name}'`);
        continue;
      }
      byName.set(loaded.name, loaded);
      skills.push(loaded);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, byName };
}

export async function expandSkillPrompt(
  skill: Skill,
  opts: SkillExpansionOptions,
): Promise<string> {
  return expandSkillText(skill, skill.body, opts);
}

export async function expandSkillText(
  skill: Skill,
  text: string,
  opts: SkillExpansionOptions,
): Promise<string> {
  const withVariables = text
    .replace(/\{\{\s*args\s*\}\}/g, opts.args ?? '')
    .replace(/\$\{HARNESS_SKILL_DIR\}/g, skill.dir)
    .replace(/\$\{HARNESS_SESSION_ID\}/g, opts.sessionId ?? '');
  return interpolateShellCommands(withVariables, skill.dir);
}

export async function reloadSkill(skill: Skill, warn?: (message: string) => void): Promise<Skill> {
  const loaded = await loadSkillFile(
    skill.path,
    skill.realpath,
    { source: skill.source, trustTier: skill.trustTier },
    warn,
  );
  if (!loaded) throw new Error(`skill '${skill.name}' could not be reloaded`);
  return loaded;
}

export async function loadSkillFromPath(
  path: string,
  classification: SkillClassification,
  warn?: (message: string) => void,
): Promise<Skill | null> {
  try {
    return await loadSkillFile(path, await realpath(path), classification, warn);
  } catch (err) {
    warn?.(`skill skipped (${path}): ${errorMessage(err)}`);
    return null;
  }
}

async function loadSkillFile(
  path: string,
  rp: string,
  classification: SkillClassification,
  warn?: (message: string) => void,
): Promise<Skill | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const guard = await guardSkillLoad({
      path,
      raw,
      trustTier: classification.trustTier,
    });
    if (guard.action === 'block') {
      warn?.(`skill skipped (${path}): ${formatGuardBlockMessage(guard)}`);
      return null;
    }
    const parsed = parseMarkdownFrontmatter(raw);
    const frontmatter = SkillFrontmatterSchema.parse(parsed.frontmatter);
    const rigor = validateWhenToUse(frontmatter.whenToUse);
    if (!rigor.ok) {
      warn?.(`skill '${frontmatter.name}' (${path}): ${rigor.reason}`);
    }
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      allowedTools: frontmatter.allowedTools,
      path,
      realpath: rp,
      dir: dirname(path),
      source: classification.source,
      trustTier: classification.trustTier,
      metadata: {
        harness: normalizeHarnessMetadata(frontmatter.metadata.harness),
      },
      guard,
      body: parsed.body.trim(),
    };
  } catch (err) {
    warn?.(`skill skipped (${path}): ${errorMessage(err)}`);
    return null;
  }
}

function classifyUserSkill(file: string, root: string): SkillClassification {
  const firstSegment = relative(root, file).split(sep)[0];
  if (firstSegment === 'agent-created') {
    return { source: 'agent-created', trustTier: 'agent-created' };
  }
  if (firstSegment === 'trusted' || firstSegment === basename(file)) {
    return { source: 'user', trustTier: 'trusted' };
  }
  return { source: 'community', trustTier: 'community' };
}

function normalizeHarnessMetadata(
  raw: z.infer<typeof MetadataHarnessSchema>,
): SkillHarnessMetadata {
  return {
    requiresToolsets: raw.requires_toolsets,
    requiresTools: raw.requires_tools,
    fallbackForToolsets: raw.fallback_for_toolsets,
    fallbackForTools: raw.fallback_for_tools,
  };
}

function parseMarkdownFrontmatter(raw: string): { frontmatter: unknown; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('missing YAML frontmatter');
  return {
    frontmatter: parseYaml(match[1] ?? ''),
    body: match[2] ?? '',
  };
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  await walk(root, out);
  return out.sort();
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const directorySkill = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md',
  );
  if (directorySkill) {
    out.push(join(dir, directorySkill.name));
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, out);
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      out.push(path);
    }
  }
}

async function interpolateShellCommands(body: string, cwd: string): Promise<string> {
  const matches = Array.from(body.matchAll(SHELL_INTERPOLATION_RE));
  if (matches.length === 0) return body;
  let out = body;
  for (const match of matches) {
    const full = match[0];
    const command = (match[1] ?? match[2])?.trim();
    if (!command) continue;
    const replacement = await runInterpolationCommand(command, cwd);
    out = out.replace(full, replacement);
  }
  return out;
}

async function runInterpolationCommand(command: string, cwd: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SHELL_TIMEOUT_MS);
  try {
    const proc = Bun.spawn(['bash', '-lc', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: ctl.signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return `[inline-shell error: ${command}\nexit_code: ${exitCode}\n${stderr.trimEnd()}]`;
    }
    return truncateShellOutput(stdout.trimEnd());
  } catch (err) {
    return `[inline-shell error: ${command}\n${errorMessage(err)}]`;
  } finally {
    clearTimeout(timer);
  }
}

function truncateShellOutput(text: string): string {
  if (text.length <= SHELL_OUTPUT_CAP) return text;
  return `${text.slice(0, SHELL_OUTPUT_CAP)}\n[truncated: shell interpolation exceeded ${SHELL_OUTPUT_CAP} chars]`;
}

function errorMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}
