// Phase 13.3 — /review slash command. Lists, shows, approves, rejects
// pending proposals filed by review sub-agents (memory_propose /
// skill_propose). Approving promotes the proposal: memory bodies append
// to MEMORY.md or USER.md; skills copy to skills/agent-created/<name>/.

import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import chalk from 'chalk';
import { proposalPath, reviewDir, skillProposalDir } from '../review/paths.js';
import {
  parseConsolidationProposal,
  parseMemoryProposal,
  parseSkillProposalMeta,
  serializeConsolidationProposal,
  serializeMemoryProposal,
  serializeSkillProposalMeta,
} from '../review/proposal.js';
import type { CommandContext, SlashCommand } from './types.js';

const STATE_COLORS = {
  pending: chalk.yellow,
  approved: chalk.green,
  rejected: chalk.red,
};

interface PendingItem {
  id: string;
  kind: 'memory' | 'skills' | 'consolidation';
  target: string;
}

type FoundProposal =
  | { kind: 'memory'; path: string }
  | { kind: 'skills'; path: string }
  | { kind: 'consolidation'; path: string };

function listPending(home: string): PendingItem[] {
  const out: PendingItem[] = [];

  for (const kind of ['memory', 'consolidation'] as const) {
    const dir = reviewDir(home, 'pending', kind);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const parsed =
          kind === 'memory' ? parseMemoryProposal(raw) : parseConsolidationProposal(raw);
        out.push({
          id: parsed.proposalId,
          kind,
          target: 'target' in parsed ? parsed.target : 'MEMORY.md',
        });
      } catch {
        // skip malformed
      }
    }
  }

  const skillsDir = reviewDir(home, 'pending', 'skills');
  if (existsSync(skillsDir)) {
    for (const sub of readdirSync(skillsDir)) {
      const metaFile = join(skillsDir, sub, 'meta.json');
      if (!existsSync(metaFile)) continue;
      try {
        const meta = parseSkillProposalMeta(readFileSync(metaFile, 'utf-8'));
        out.push({ id: meta.proposalId, kind: 'skills', target: meta.skillName });
      } catch {
        // skip malformed
      }
    }
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function findProposal(home: string, state: 'pending', id: string): FoundProposal | null {
  const memPath = proposalPath(home, state, 'memory', id);
  if (existsSync(memPath)) return { kind: 'memory', path: memPath };
  const consPath = proposalPath(home, state, 'consolidation', id);
  if (existsSync(consPath)) return { kind: 'consolidation', path: consPath };
  const skillDir = skillProposalDir(home, state, id);
  if (existsSync(skillDir)) return { kind: 'skills', path: skillDir };
  return null;
}

function moveTo(state: 'approved' | 'rejected', home: string, found: FoundProposal): void {
  if (found.kind === 'skills') {
    const id = basename(found.path);
    const dest = skillProposalDir(home, state, id);
    mkdirSync(reviewDir(home, state, 'skills'), { recursive: true });
    cpSync(found.path, dest, { recursive: true });
    rmSync(found.path, { recursive: true, force: true });
    const metaFile = join(dest, 'meta.json');
    const meta = parseSkillProposalMeta(readFileSync(metaFile, 'utf-8'));
    writeFileSync(metaFile, serializeSkillProposalMeta({ ...meta, status: state }));
    return;
  }
  const id = basename(found.path).replace(/\.md$/, '');
  const dest = proposalPath(home, state, found.kind, id);
  mkdirSync(reviewDir(home, state, found.kind), { recursive: true });
  const raw = readFileSync(found.path, 'utf-8');
  if (found.kind === 'memory') {
    const parsed = parseMemoryProposal(raw);
    writeFileSync(dest, serializeMemoryProposal({ ...parsed, status: state }));
  } else {
    const parsed = parseConsolidationProposal(raw);
    writeFileSync(dest, serializeConsolidationProposal({ ...parsed, status: state }));
  }
  rmSync(found.path);
}

function applyMemoryApproval(home: string, raw: string): void {
  const parsed = parseMemoryProposal(raw);
  const memDir = join(home, 'memory');
  mkdirSync(memDir, { recursive: true });
  const target = join(memDir, parsed.target);
  const block = `\n\n<!-- proposal:${parsed.proposalId} -->\n${parsed.body}\n`;
  if (existsSync(target)) {
    appendFileSync(target, block);
  } else {
    writeFileSync(target, block.trimStart());
  }
}

function applySkillApproval(home: string, dir: string): void {
  const meta = parseSkillProposalMeta(readFileSync(join(dir, 'meta.json'), 'utf-8'));
  const skillDir = join(home, 'skills', 'agent-created', meta.skillName);
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(join(dir, 'SKILL.md'), join(skillDir, 'SKILL.md'));
}

function applyConsolidationApproval(home: string, raw: string): void {
  const parsed = parseConsolidationProposal(raw);
  const memDir = join(home, 'memory');
  mkdirSync(memDir, { recursive: true });
  const target = join(memDir, parsed.target);
  const block = `\n\n<!-- consolidation:${parsed.proposalId} affected:${parsed.affectedEntries.join(',')} -->\n${parsed.body}\n`;
  if (existsSync(target)) {
    appendFileSync(target, block);
  } else {
    writeFileSync(target, block.trimStart());
  }
  // NOTE: actually deleting the affected entries from MEMORY.md is left
  // as a follow-up. v0 appends the consolidation result; user removes
  // originals manually. Documented in DECISIONS.md follow-ups.
}

const USAGE = 'usage: /review [list|show <id>|approve <id>|reject <id>|consolidate]';

async function handleReview(rawArgs: string, ctx: CommandContext): Promise<string> {
  const home = ctx.harnessHome;
  if (!home) {
    return chalk.red('no harness home configured for /review');
  }
  const args = rawArgs.trim();

  if (args === '' || args === 'list') {
    const items = listPending(home);
    if (items.length === 0) {
      return chalk.dim('no pending proposals');
    }
    const lines = items.map(
      (it) =>
        `${STATE_COLORS.pending('pending')} ${chalk.cyan(it.kind.padEnd(13))} ${it.id}  ${chalk.dim('→')} ${it.target}`,
    );
    return lines.join('\n');
  }

  const firstSpace = args.search(/\s/);
  const verb = firstSpace === -1 ? args : args.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : args.slice(firstSpace + 1).trim();

  if (verb === 'show') {
    if (!rest) return 'usage: /review show <id>';
    const found = findProposal(home, 'pending', rest);
    if (!found) return chalk.red(`proposal ${rest} not found`);
    if (found.kind === 'skills') {
      const meta = readFileSync(join(found.path, 'meta.json'), 'utf-8');
      const skill = readFileSync(join(found.path, 'SKILL.md'), 'utf-8');
      return `${chalk.cyan(`# proposal ${rest} (skill)\n`)}${meta}\n\n${chalk.dim('--- SKILL.md ---\n')}${skill}`;
    }
    return chalk.cyan(`# proposal ${rest}\n\n`) + readFileSync(found.path, 'utf-8');
  }

  if (verb === 'approve') {
    if (!rest) return 'usage: /review approve <id>';
    const found = findProposal(home, 'pending', rest);
    if (!found) return chalk.red(`proposal ${rest} not found`);
    if (found.kind === 'memory') {
      applyMemoryApproval(home, readFileSync(found.path, 'utf-8'));
    } else if (found.kind === 'skills') {
      applySkillApproval(home, found.path);
    } else {
      applyConsolidationApproval(home, readFileSync(found.path, 'utf-8'));
    }
    moveTo('approved', home, found);
    return chalk.green(`approved ${rest}`);
  }

  if (verb === 'reject') {
    if (!rest) return 'usage: /review reject <id>';
    const found = findProposal(home, 'pending', rest);
    if (!found) return chalk.red(`proposal ${rest} not found`);
    moveTo('rejected', home, found);
    return chalk.yellow(`rejected ${rest}`);
  }

  if (verb === 'consolidate') {
    if (!ctx.reviewManager) {
      return chalk.red('review manager not available — open a session first');
    }
    ctx.reviewManager.runConsolidationPass(home);
    return chalk.dim('consolidation pass dispatched (results will appear in /review list)');
  }

  return chalk.yellow(USAGE);
}

export const REVIEW_OPS_COMMANDS: SlashCommand[] = [
  {
    type: 'local',
    name: 'review',
    description: 'List, show, approve, or reject pending review proposals.',
    usage: '/review [list|show <id>|approve <id>|reject <id>|consolidate]',
    call: async (rawArgs, ctx) => handleReview(rawArgs, ctx),
  },
];
