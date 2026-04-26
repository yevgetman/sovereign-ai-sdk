// Skill guard scanner. Phase 9.5 blocks high-risk third-party skill content
// before it reaches the prompt or gets written as an agent-created skill.

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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
  { level: 'critical', category: 'destructive-operation', pattern: /\bshred\b/i },
  { level: 'critical', category: 'destructive-operation', pattern: /\bformat\b/i },
  { level: 'critical', category: 'destructive-sql', pattern: /\bDROP\s+(DATABASE|SCHEMA)\b/i },
  { level: 'critical', category: 'destructive-sql', pattern: /\bTRUNCATE\s+TABLE\b/i },
  { level: 'medium', category: 'persistence', pattern: /\bcrontab\b|\bcron\b/i },
  {
    level: 'medium',
    category: 'persistence',
    pattern: /\.(?:bashrc|zshrc|profile|zprofile|zshenv)\b/i,
  },
];

export async function guardSkillLoad(opts: {
  path: string;
  raw: string;
  trustTier: SkillTrustTier;
}): Promise<SkillGuardDecision> {
  const texts = [{ file: opts.path, text: opts.raw }];
  if (isDirectorySkill(opts.path)) {
    texts.push(...(await readSkillDirectoryTexts(opts.path)));
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

async function readSkillDirectoryTexts(
  skillPath: string,
): Promise<{ file: string; text: string }[]> {
  const dir = dirname(skillPath);
  if (!existsSync(dir)) return [];
  const out: { file: string; text: string }[] = [];
  await walkTextFiles(dir, out);
  return out.filter((entry) => entry.file !== skillPath);
}

async function walkTextFiles(dir: string, out: { file: string; text: string }[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkTextFiles(path, out);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      out.push({ file: path, text: await readFile(path, 'utf8') });
    } catch {
      // Binary/unreadable reference files are ignored by the scanner.
    }
  }
}
