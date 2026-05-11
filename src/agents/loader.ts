// Agent definition loader (Phase 13). Scans project, user, and bundle
// agent directories, parses markdown frontmatter, and returns a registry
// keyed by name. Project entries beat user entries which beat bundle
// entries on duplicate names (first wins). Realpath dedupe collapses
// symlinks. The shape and traversal mirror src/skills/loader.ts so future
// changes (directory-form agents, guard scanner, hot reload) port across
// without re-engineering.

import { existsSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AgentDefinition, AgentRegistry, AgentSource, AgentTrustTier } from './types.js';

const AGENT_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DEFAULT_MAX_TURNS = 50;

const FrontmatterSchema = z
  .object({
    name: z
      .string()
      .regex(
        AGENT_NAME_REGEX,
        'must start with a letter and contain only letters, digits, hyphen, underscore',
      ),
    description: z.string().min(1),
    whenToUse: z.string().optional(),
    systemPrompt: z.string().optional(),
    allowedTools: z.array(z.string()).default([]),
    model: z.string().optional(),
    role: z.string().optional(),
    maxTurns: z.number().int().positive().default(DEFAULT_MAX_TURNS),
    readOnly: z.boolean().default(false),
    supportsMissionState: z.boolean().default(false),
  })
  .passthrough();

export type LoadAgentsOptions = {
  harnessHome: string;
  cwd: string;
  /** When set, scans bundle-relative agent root; absent in generic-agent mode. */
  bundleRoot?: string;
  warn?: (message: string) => void;
};

type AgentClassification = {
  source: AgentSource;
  trustTier: AgentTrustTier;
};

type AgentRoot = AgentClassification & {
  path: string;
};

export async function loadAgents(opts: LoadAgentsOptions): Promise<AgentRegistry> {
  const roots: AgentRoot[] = [
    {
      source: 'project',
      trustTier: 'trusted',
      path: join(opts.cwd, '.harness', 'agents'),
    },
    {
      source: 'user',
      trustTier: 'trusted',
      path: join(opts.harnessHome, 'agents'),
    },
  ];
  if (opts.bundleRoot !== undefined) {
    roots.push({
      source: 'bundle',
      trustTier: 'builtin',
      path: join(opts.bundleRoot, 'agents'),
    });
  }

  const seenRealpaths = new Set<string>();
  const byName = new Map<string, AgentDefinition>();
  const agents: AgentDefinition[] = [];

  for (const root of roots) {
    for (const file of await listMarkdownFiles(root.path)) {
      let rp: string;
      try {
        rp = await realpath(file);
      } catch (err) {
        opts.warn?.(`agent skipped (${file}): ${errorMessage(err)}`);
        continue;
      }
      if (seenRealpaths.has(rp)) continue;
      seenRealpaths.add(rp);

      const loaded = await loadAgentFile(file, rp, root, opts.warn);
      if (!loaded) continue;
      if (byName.has(loaded.name)) {
        opts.warn?.(`agent skipped (${file}): duplicate agent name '${loaded.name}'`);
        continue;
      }
      byName.set(loaded.name, loaded);
      agents.push(loaded);
    }
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, byName };
}

async function loadAgentFile(
  path: string,
  rp: string,
  classification: AgentClassification,
  warn?: (message: string) => void,
): Promise<AgentDefinition | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = parseMarkdownFrontmatter(raw);
    const frontmatter = FrontmatterSchema.parse(parsed.frontmatter);
    if (frontmatter.model !== undefined && frontmatter.role !== undefined) {
      warn?.(`agent skipped (${path}): cannot set both 'model' and 'role'`);
      return null;
    }
    const systemPrompt = (frontmatter.systemPrompt ?? parsed.body).trim();
    if (systemPrompt.length === 0) {
      warn?.(
        `agent skipped (${path}): systemPrompt is empty (set it in frontmatter or as the markdown body)`,
      );
      return null;
    }
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter.whenToUse !== undefined ? { whenToUse: frontmatter.whenToUse } : {}),
      systemPrompt,
      allowedTools: frontmatter.allowedTools,
      ...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),
      ...(frontmatter.role !== undefined ? { role: frontmatter.role } : {}),
      maxTurns: frontmatter.maxTurns,
      readOnly: frontmatter.readOnly,
      supportsMissionState: frontmatter.supportsMissionState,
      path,
      realpath: rp,
      dir: dirname(path),
      source: classification.source,
      trustTier: classification.trustTier,
    };
  } catch (err) {
    warn?.(`agent skipped (${path}): ${errorMessage(err)}`);
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

function errorMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}
