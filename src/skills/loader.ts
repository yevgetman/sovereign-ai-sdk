// Skill loader and prompt expansion. Scans user/project/bundle skill
// directories, parses markdown frontmatter, and lazily expands skill bodies
// when a slash command or SkillTool invokes one.

import { existsSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Skill, SkillExpansionOptions, SkillRegistry, SkillSource } from './types.js';

const SkillFrontmatterSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'must be a slash-command-safe name'),
    description: z.string().min(1),
    allowedTools: z.array(z.string()).default([]),
    whenToUse: z.string().default(''),
  })
  .passthrough();

const SHELL_INTERPOLATION_RE = /`!([^`]+)`/g;
const SHELL_TIMEOUT_MS = 10_000;
const SHELL_OUTPUT_CAP = 16 * 1024;

export type LoadSkillsOptions = {
  harnessHome: string;
  cwd: string;
  bundleRoot: string;
  warn?: (message: string) => void;
};

type SkillRoot = { source: SkillSource; path: string };

export async function loadSkills(opts: LoadSkillsOptions): Promise<SkillRegistry> {
  const roots: SkillRoot[] = [
    { source: 'project', path: join(opts.cwd, '.harness', 'skills') },
    { source: 'user', path: join(opts.harnessHome, 'skills') },
    { source: 'bundle', path: join(opts.bundleRoot, 'skills') },
  ];

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

      const loaded = await loadSkillFile(file, rp, root.source, opts.warn);
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
  const withArgs = skill.body.replace(/\{\{\s*args\s*\}\}/g, opts.args ?? '');
  return interpolateShellCommands(withArgs, opts.cwd);
}

export async function reloadSkill(skill: Skill, warn?: (message: string) => void): Promise<Skill> {
  return (await loadSkillFile(skill.path, skill.realpath, skill.source, warn)) ?? skill;
}

async function loadSkillFile(
  path: string,
  rp: string,
  source: SkillSource,
  warn?: (message: string) => void,
): Promise<Skill | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = parseMarkdownFrontmatter(raw);
    const frontmatter = SkillFrontmatterSchema.parse(parsed.frontmatter);
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      allowedTools: frontmatter.allowedTools,
      path,
      realpath: rp,
      source,
      body: parsed.body.trim(),
    };
  } catch (err) {
    warn?.(`skill skipped (${path}): ${errorMessage(err)}`);
    return null;
  }
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
    const command = match[1]?.trim();
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
      return `[shell interpolation failed: ${command}\nexit_code: ${exitCode}\n${stderr.trimEnd()}]`;
    }
    return truncateShellOutput(stdout.trimEnd());
  } catch (err) {
    return `[shell interpolation failed: ${command}\n${errorMessage(err)}]`;
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
