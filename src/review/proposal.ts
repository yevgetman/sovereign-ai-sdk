// Provenance frontmatter + body schemas for review proposals (memory / skill / consolidation).

import { z } from 'zod';

const ProvenanceBase = {
  proposalId: z.string().min(1),
  sessionId: z.string().min(1),
  parentSessionId: z.string().nullable(),
  traceId: z.string().min(1),
  author: z.string().min(1),
  createdAt: z.string().min(1),
  status: z.enum(['pending', 'approved', 'rejected']),
};

const MemoryProposalSchema = z.object({
  ...ProvenanceBase,
  type: z.literal('memory'),
  target: z.enum(['MEMORY.md', 'USER.md']),
  memoryType: z.enum(['user', 'feedback', 'project', 'reference']),
  sourceMessageRange: z.tuple([z.number(), z.number()]),
  sourceHash: z.string(),
  sourceExcerpt: z.string(),
  body: z.string(),
});

const SkillProposalMetaSchema = z.object({
  ...ProvenanceBase,
  type: z.literal('skill'),
  skillName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  sourceMessageRange: z.tuple([z.number(), z.number()]),
  sourceHash: z.string(),
  sourceExcerpt: z.string(),
});

const ConsolidationProposalSchema = z.object({
  ...ProvenanceBase,
  type: z.literal('consolidation'),
  target: z.enum(['MEMORY.md', 'USER.md']),
  affectedEntries: z.array(z.string()).min(1),
  body: z.string(),
});

export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;
export type SkillProposalMeta = z.infer<typeof SkillProposalMetaSchema>;
export type ConsolidationProposal = z.infer<typeof ConsolidationProposalSchema>;

const FRONTMATTER_DELIM = '---';

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    throw new Error('proposal: missing opening frontmatter delimiter');
  }
  const closeIdx = lines.slice(1).findIndex((l) => l.trim() === FRONTMATTER_DELIM);
  if (closeIdx === -1) {
    throw new Error('proposal: missing closing frontmatter delimiter');
  }
  const frontmatter = lines.slice(1, closeIdx + 1).join('\n');
  const body = lines.slice(closeIdx + 2).join('\n');
  return { frontmatter, body };
}

function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '~' || trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^\[.*\]$/.test(trimmed)) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((p) => parseYamlValue(p));
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFlatYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  const listAcc: string[] = [];
  const lines = yaml.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('  - ')) {
      const v = parseYamlValue(line.slice(4));
      if (typeof v === 'string') listAcc.push(v);
      continue;
    }
    if (currentKey !== null && listAcc.length > 0) {
      result[currentKey] = [...listAcc];
      listAcc.length = 0;
      currentKey = null;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1);
    if (valueRaw.trim() === '') {
      currentKey = key;
      continue;
    }
    result[key] = parseYamlValue(valueRaw);
  }
  if (currentKey !== null && listAcc.length > 0) {
    result[currentKey] = [...listAcc];
  }
  return result;
}

function serializeYamlValue(v: unknown): string {
  if (v === null) return '~';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (v.every((item) => typeof item === 'number')) return `[${v.join(', ')}]`;
    return `\n${v.map((item) => `  - ${item}`).join('\n')}`;
  }
  const s = String(v);
  if (s === '' || /[:\n#]/.test(s) || s.trim() !== s) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

function serializeFlatYaml(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${serializeYamlValue(v)}`)
    .join('\n');
}

export function parseMemoryProposal(raw: string): MemoryProposal {
  const { frontmatter, body } = splitFrontmatter(raw);
  const parsed = parseFlatYaml(frontmatter);
  return MemoryProposalSchema.parse({ ...parsed, body });
}

export function serializeMemoryProposal(p: MemoryProposal): string {
  const { body, ...meta } = p;
  return `---\n${serializeFlatYaml(meta)}\n---\n${body}`;
}

export function parseConsolidationProposal(raw: string): ConsolidationProposal {
  const { frontmatter, body } = splitFrontmatter(raw);
  const parsed = parseFlatYaml(frontmatter);
  return ConsolidationProposalSchema.parse({ ...parsed, body });
}

export function serializeConsolidationProposal(p: ConsolidationProposal): string {
  const { body, ...meta } = p;
  return `---\n${serializeFlatYaml(meta)}\n---\n${body}`;
}

export function parseSkillProposalMeta(raw: string): SkillProposalMeta {
  return SkillProposalMetaSchema.parse(JSON.parse(raw));
}

export function serializeSkillProposalMeta(p: SkillProposalMeta): string {
  return JSON.stringify(p, null, 2);
}
