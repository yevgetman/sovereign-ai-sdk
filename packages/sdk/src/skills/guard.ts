// Skill guard scanner. Phase 9.5 blocks high-risk third-party skill content
// before it reaches the prompt or gets written as an agent-created skill.

import { opendir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { DEFAULT_SKILL_DISCOVERY_LIMITS, isPathWithin } from './discovery.js';
import { readBoundedSkillContent } from './fileRead.js';
import type {
  SkillGuardDecision,
  SkillGuardFinding,
  SkillGuardLevel,
  SkillTrustTier,
} from './types.js';

type GuardPattern = {
  level: SkillGuardLevel;
  category: string;
  pattern: RegExp;
};

const GUARD_PATTERNS: GuardPattern[] = [
  { level: 'critical', category: 'exfiltration', pattern: /\bcurl\b[^\n|;&]*\|/i },
  { level: 'critical', category: 'exfiltration', pattern: /(?:~\/)?\.ssh\b/i },
  { level: 'critical', category: 'exfiltration', pattern: /(?:~\/)?\.aws\b/i },
  { level: 'medium', category: 'exfiltration', pattern: /\bcat\s+~\/\.config\/\*/i },
  { level: 'medium', category: 'prompt-injection', pattern: /ignore previous instructions/i },
  { level: 'medium', category: 'prompt-injection', pattern: /system prompt override/i },
  { level: 'medium', category: 'prompt-injection', pattern: /\byou are now\b/i },
  { level: 'critical', category: 'destructive-operation', pattern: /\brm\s+-rf\s+\/(?:\s|$)/i },
  { level: 'critical', category: 'destructive-operation', pattern: /\bdd\s+if=/i },
  { level: 'critical', category: 'destructive-operation', pattern: /\bshred\s+/i },
  // `format` previously matched any occurrence of the word — including
  // benign uses like "in this format:" — and silently blocked legitimate
  // skills. Tighten to disk-format commands only: Windows `format C:` /
  // `format X:`, Unix-ish `format /dev/...`, mkfs.* invocations.
  { level: 'critical', category: 'destructive-operation', pattern: /\bformat\s+[A-Za-z]:\s/i },
  { level: 'critical', category: 'destructive-operation', pattern: /\bformat\s+\/dev\//i },
  { level: 'critical', category: 'destructive-operation', pattern: /\bmkfs\.[a-z0-9]+\s+\//i },
  { level: 'critical', category: 'destructive-sql', pattern: /\bDROP\s+(DATABASE|SCHEMA)\b/i },
  { level: 'critical', category: 'destructive-sql', pattern: /\bTRUNCATE\s+TABLE\b/i },
  { level: 'medium', category: 'persistence', pattern: /\bcrontab\b|\bcron\b/i },
  {
    level: 'medium',
    category: 'persistence',
    pattern: /\.(?:bashrc|zshrc|profile|zprofile|zshenv)\b/i,
  },
];

export type SkillGuardResourceBudget = {
  bytesRemaining: number;
  entriesRemaining: number;
  fileBytesLimit: number;
  depthLimit: number;
};

export async function guardSkillLoad(opts: {
  path: string;
  raw: string;
  trustTier: SkillTrustTier;
  resourceBudget?: SkillGuardResourceBudget;
  resourceRoot?: string;
}): Promise<SkillGuardDecision> {
  const texts = [{ file: opts.path, text: opts.raw }];
  if (isDirectorySkill(opts.path) || opts.resourceRoot !== undefined) {
    try {
      texts.push(
        ...(await readSkillDirectoryTexts(opts.path, opts.resourceBudget, opts.resourceRoot)),
      );
    } catch {
      return {
        action: 'block',
        findings: [
          {
            level: 'critical',
            category: 'resource-limit',
            pattern: 'incomplete bounded skill resource scan',
            file: opts.path,
          },
        ],
      };
    }
  }
  return decideGuard(scanTexts(texts), opts.trustTier);
}

export function guardSkillText(text: string, trustTier: SkillTrustTier): SkillGuardDecision {
  return decideGuard(scanTexts([{ file: 'SKILL.md', text }]), trustTier);
}

export function formatGuardBlockMessage(decision: SkillGuardDecision): string {
  const first = decision.findings[0];
  if (!first) return '[BLOCKED: skill guard policy]';
  return `[BLOCKED: ${first.category} pattern]`;
}

function scanTexts(texts: { file: string; text: string }[]): SkillGuardFinding[] {
  const findings: SkillGuardFinding[] = [];
  for (const { file, text } of texts) {
    for (const guard of GUARD_PATTERNS) {
      if (!guard.pattern.test(text)) continue;
      findings.push({
        level: guard.level,
        category: guard.category,
        pattern: guard.pattern.source,
        file,
      });
    }
  }
  return findings;
}

function decideGuard(findings: SkillGuardFinding[], trustTier: SkillTrustTier): SkillGuardDecision {
  const highest = highestLevel(findings);
  if (!highest || trustTier === 'builtin') return { action: 'allow', findings };
  if (trustTier === 'trusted') {
    return { action: highest === 'critical' ? 'block' : 'allow', findings };
  }
  if (trustTier === 'community') {
    return { action: highest === 'info' ? 'allow' : 'block', findings };
  }
  return { action: highest === 'critical' ? 'ask' : 'allow', findings };
}

function highestLevel(findings: SkillGuardFinding[]): SkillGuardLevel | null {
  if (findings.some((finding) => finding.level === 'critical')) return 'critical';
  if (findings.some((finding) => finding.level === 'medium')) return 'medium';
  if (findings.some((finding) => finding.level === 'info')) return 'info';
  return null;
}

function isDirectorySkill(path: string): boolean {
  return basename(path).toLowerCase() === 'skill.md';
}

function isStoreInternal(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === '.sov-skill-store' ||
    normalized.startsWith('.sov-skill-stage-') ||
    normalized.startsWith('.sov-skill-backup-')
  );
}

async function readSkillDirectoryTexts(
  skillPath: string,
  resourceBudget?: SkillGuardResourceBudget,
  resourceRoot?: string,
): Promise<{ file: string; text: string }[]> {
  const dir = await realpath(resourceRoot ?? dirname(skillPath));
  if (resourceRoot !== undefined && dir !== resourceRoot)
    throw new Error('skill resource root changed');
  const canonicalSkill = await realpath(skillPath);
  const budget = resourceBudget ?? {
    bytesRemaining: DEFAULT_SKILL_DISCOVERY_LIMITS.maxTotalBytes,
    entriesRemaining: DEFAULT_SKILL_DISCOVERY_LIMITS.maxEntries,
    fileBytesLimit: DEFAULT_SKILL_DISCOVERY_LIMITS.maxFileBytes,
    depthLimit: DEFAULT_SKILL_DISCOVERY_LIMITS.maxDepth,
  };
  const out: { file: string; text: string }[] = [];
  const seen = new Set<string>();
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > budget.depthLimit) throw new Error('skill resource depth limit exceeded');
    const rp = await realpath(path);
    if (!isPathWithin(dir, rp) || relative(dir, rp).split(sep).some(isStoreInternal))
      throw new Error('skill resource escaped its directory');
    if (seen.has(rp)) return;
    seen.add(rp);
    const entries: { name: string; directory: boolean; file: boolean }[] = [];
    const handle = await opendir(rp);
    for await (const entry of handle) {
      if (budget.entriesRemaining <= 0) throw new Error('skill resource entry limit exceeded');
      budget.entriesRemaining -= 1;
      if (
        ['.sov-skill-store', '.git', '.svn', '.hg', 'node_modules', 'vendor'].includes(
          entry.name.toLowerCase(),
        ) ||
        isStoreInternal(entry.name)
      )
        continue;
      entries.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = join(rp, entry.name);
      if (file === canonicalSkill) continue;
      if (entry.directory) {
        await walk(file, depth + 1);
        continue;
      }
      // Reference symlinks are not traversed by the guard. Activation/view
      // checks their canonical containment separately before exposing them.
      if (!entry.file) continue;
      const canonical = await realpath(file);
      if (canonical !== file || !isPathWithin(dir, canonical))
        throw new Error('skill resource changed its real path');
      const maxBytes = Math.min(budget.fileBytesLimit, budget.bytesRemaining);
      const text = await readBoundedSkillContent(file, canonical, maxBytes, (bytes) => {
        budget.bytesRemaining -= bytes;
      });
      out.push({ file: canonical, text });
    }
  };
  await walk(dir, 0);
  if ((await realpath(dir)) !== dir) throw new Error('skill resource root changed during scan');
  return out;
}
