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
import { MEMORY_CAPS, type MemoryFile } from '../memory/bounded.js';
import { type ReviewState, proposalPath, reviewDir, skillProposalDir } from '../review/paths.js';
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

function findProposal(home: string, state: ReviewState, id: string): FoundProposal | null {
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

/** Phase 13.3 follow-up (backlog Item 1) — pre-flight the bounded memory
 *  cap before appending. Returns an error message when appending `block`
 *  would exceed the cap; returns null when safe to write. */
function checkCapBeforeAppend(
  target: string,
  currentSize: number,
  blockLength: number,
): string | null {
  const file = target as MemoryFile;
  const cap = MEMORY_CAPS[file];
  if (cap === undefined) return null; // unknown file — caller decides
  const projected = currentSize + blockLength;
  if (projected <= cap) return null;
  return `cap exceeded for ${target}: would grow ${currentSize} → ${projected} chars (cap ${cap}). Run /review consolidate to merge entries, or trim ${target} manually.`;
}

function applyMemoryApproval(home: string, raw: string): string | null {
  const parsed = parseMemoryProposal(raw);
  const memDir = join(home, 'memory');
  mkdirSync(memDir, { recursive: true });
  const target = join(memDir, parsed.target);
  const block = `\n\n<!-- proposal:${parsed.proposalId} -->\n${parsed.body}\n`;

  // Phase 13.3 follow-up — pre-flight cap
  const currentSize = existsSync(target) ? readFileSync(target, 'utf-8').length : 0;
  const capError = checkCapBeforeAppend(parsed.target, currentSize, block.length);
  if (capError !== null) {
    return capError;
  }

  if (existsSync(target)) {
    appendFileSync(target, block);
  } else {
    writeFileSync(target, block.trimStart());
  }
  return null;
}

function applySkillApproval(home: string, dir: string): void {
  const meta = parseSkillProposalMeta(readFileSync(join(dir, 'meta.json'), 'utf-8'));
  const skillDir = join(home, 'skills', 'agent-created', meta.skillName);
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(join(dir, 'SKILL.md'), join(skillDir, 'SKILL.md'));
}

type ConsolidationResult = { ok: true; removed: string[] } | { ok: false; error: string };

function applyConsolidationApproval(home: string, raw: string): ConsolidationResult {
  const parsed = parseConsolidationProposal(raw);
  const memDir = join(home, 'memory');
  mkdirSync(memDir, { recursive: true });
  const target = join(memDir, parsed.target);

  // Phase 13.3 follow-up (Item 4) — remove the original blocks listed in
  // affectedEntries BEFORE computing the cap-check or appending. The
  // consolidated entry replaces them, so the post-state file size should
  // reflect that. Cap-check then runs against the post-deletion size,
  // letting net-shrinking consolidations succeed even when the pre-state
  // was at cap.
  let working = existsSync(target) ? readFileSync(target, 'utf-8') : '';
  const removed: string[] = [];
  for (const affectedId of parsed.affectedEntries) {
    const after = removeProposalBlock(working, affectedId);
    if (after !== null) {
      working = after;
      removed.push(affectedId);
    }
    // Missing affectedEntry is non-fatal — could be the user already
    // manually removed it, or a sibling consolidation already merged it.
  }

  const block = `\n\n<!-- consolidation:${parsed.proposalId} affected:${parsed.affectedEntries.join(',')} -->\n${parsed.body}\n`;

  // Cap-check uses the WORKING content size (post-deletion), not the
  // original file size. Consolidations that net-shrink should always
  // pass, even when the pre-deletion file was at cap.
  const capError = checkCapBeforeAppend(parsed.target, working.length, block.length);
  if (capError !== null) {
    return { ok: false, error: capError };
  }

  // Atomic write: deletions + append in a single writeFileSync. If the
  // target was previously empty/missing, trim the leading newlines on
  // the first block so we don't start the file with blank lines.
  const newContent = working === '' ? block.trimStart() : working + block;
  writeFileSync(target, newContent);
  return { ok: true, removed };
}

/** Phase 13.3 follow-up (backlog Item 3) — remove the block in MEMORY.md /
 *  USER.md that starts with `<!-- proposal:<id>` (memory) or
 *  `<!-- consolidation:<id>` (consolidation) and runs through the next
 *  proposal/consolidation marker (or EOF). Returns the new file content
 *  with the block removed (including any leading blank lines preceding
 *  the marker). Returns null when the marker isn't found.
 *
 *  Block contract per applyMemoryApproval / applyConsolidationApproval:
 *  each appended block starts with two newlines, then the comment line,
 *  then the body. We strip the leading newlines so the file doesn't
 *  accumulate blank-line drift after multiple revokes.
 *
 *  Auto-promoted blocks (from MemoryProposeTool's auto-promote path)
 *  have richer comments like `<!-- proposal:<id> auto-promoted session:...
 *  trace:... hash:... range:... excerpt:... -->`. The prefix match still
 *  succeeds because we only require `<!-- proposal:<id>` at the start. */
function removeProposalBlock(fileContent: string, proposalId: string): string | null {
  // Try memory marker first, then consolidation marker.
  const memMarker = `<!-- proposal:${proposalId}`;
  const consMarker = `<!-- consolidation:${proposalId}`;
  let markerStart = fileContent.indexOf(memMarker);
  let markerLen = memMarker.length;
  if (markerStart === -1) {
    markerStart = fileContent.indexOf(consMarker);
    markerLen = consMarker.length;
  }
  if (markerStart === -1) return null;

  // Walk back to absorb any leading blank lines that were inserted to
  // separate this block from the previous one.
  let blockStart = markerStart;
  while (blockStart > 0 && fileContent[blockStart - 1] === '\n') {
    blockStart--;
  }

  // Walk forward to the next `<!-- proposal:` OR `<!-- consolidation:`
  // marker OR EOF. Both kinds delimit a block.
  const searchFrom = markerStart + markerLen;
  const nextProp = fileContent.indexOf('<!-- proposal:', searchFrom);
  const nextCons = fileContent.indexOf('<!-- consolidation:', searchFrom);
  const candidates = [nextProp, nextCons].filter((i) => i !== -1);
  const nextMarker = candidates.length === 0 ? -1 : Math.min(...candidates);

  let blockEnd = nextMarker === -1 ? fileContent.length : nextMarker;
  // When we found a next marker, walk back to absorb the blank lines
  // belonging to the next block's leading separator.
  if (nextMarker !== -1) {
    while (blockEnd > 0 && fileContent[blockEnd - 1] === '\n') {
      blockEnd--;
    }
  }

  return fileContent.slice(0, blockStart) + fileContent.slice(blockEnd);
}

const USAGE =
  'usage: /review [list|show <id>|approve <id>|reject <id>|revoke <id>|consolidate|activity]';

/** Safe proposal-id segment: ASCII alphanumerics + `-` and `_`. `.` is
 *  intentionally excluded so `.`, `..`, `a.b` all fail alongside separators
 *  (`/`, `\`) and whitespace. SECURITY-LOAD-BEARING: the id is joined into a
 *  filesystem path (proposalPath / skillProposalDir), so a non-safe id would
 *  traverse out of the review dir. Mirrors validatePrincipalId in
 *  src/server/principals.ts. */
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Returns an error message when `id` is not a safe path segment, or null when
 *  it is safe to build a path from. Callers reject up front BEFORE any
 *  findProposal / path construction. */
function invalidProposalId(id: string): string | null {
  if (PROPOSAL_ID_RE.test(id)) return null;
  return `invalid proposal id ${JSON.stringify(id)}: ids may contain only letters, digits, '-', and '_'`;
}

/** Phase 13.3 follow-up (Item 16) — phantom rows above this threshold
 *  trigger an opportunistic `cleanupPhantomReviews()` when the user runs
 *  `/review activity`. Hand-tuned default; ties cleanup cost to user-
 *  facing inspection rather than a periodic background tax. */
const PHANTOM_CLEANUP_THRESHOLD = 10;

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
    const idErr = invalidProposalId(rest);
    if (idErr !== null) return chalk.red(idErr);
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
    const idErr = invalidProposalId(rest);
    if (idErr !== null) return chalk.red(idErr);
    const found = findProposal(home, 'pending', rest);
    if (!found) return chalk.red(`proposal ${rest} not found`);
    let mergedNote = '';
    if (found.kind === 'memory') {
      const err = applyMemoryApproval(home, readFileSync(found.path, 'utf-8'));
      if (err !== null) {
        return chalk.red(err);
      }
    } else if (found.kind === 'skills') {
      applySkillApproval(home, found.path);
    } else {
      const result = applyConsolidationApproval(home, readFileSync(found.path, 'utf-8'));
      if (!result.ok) {
        return chalk.red(result.error);
      }
      if (result.removed.length > 0) {
        mergedNote = ` (merged ${result.removed.length} ${result.removed.length === 1 ? 'entry' : 'entries'})`;
      }
    }
    moveTo('approved', home, found);
    return chalk.green(`approved ${rest}${mergedNote}`);
  }

  if (verb === 'reject') {
    if (!rest) return 'usage: /review reject <id>';
    const idErr = invalidProposalId(rest);
    if (idErr !== null) return chalk.red(idErr);
    const found = findProposal(home, 'pending', rest);
    if (!found) return chalk.red(`proposal ${rest} not found`);
    moveTo('rejected', home, found);
    return chalk.yellow(`rejected ${rest}`);
  }

  if (verb === 'revoke') {
    if (!rest) return 'usage: /review revoke <id>';
    const idErr = invalidProposalId(rest);
    if (idErr !== null) return chalk.red(idErr);
    // Only approved entries can be revoked — pending ones use /review reject.
    const found = findProposal(home, 'approved', rest);
    if (!found) return chalk.red(`approved proposal ${rest} not found`);

    if (found.kind === 'memory' || found.kind === 'consolidation') {
      const raw = readFileSync(found.path, 'utf-8');
      const parsed =
        found.kind === 'memory' ? parseMemoryProposal(raw) : parseConsolidationProposal(raw);
      const memDir = join(home, 'memory');
      const target = join(memDir, parsed.target);
      if (!existsSync(target)) {
        // Target file gone; still record user intent by moving the proposal.
        moveTo('rejected', home, found);
        return chalk.yellow(
          `target ${parsed.target} does not exist; proposal ${rest} moved to rejected/`,
        );
      }
      const before = readFileSync(target, 'utf-8');
      const after = removeProposalBlock(before, parsed.proposalId);
      if (after === null) {
        // Block not in file — proposal may have been manually edited away.
        // Still move the proposal to rejected/ so the queue reflects intent.
        moveTo('rejected', home, found);
        return chalk.yellow(
          `block for ${rest} not found in ${parsed.target} (already removed?); proposal moved to rejected/`,
        );
      }
      writeFileSync(target, after);
      moveTo('rejected', home, found);
      return chalk.green(`revoked ${rest}`);
    }

    if (found.kind === 'skills') {
      const meta = parseSkillProposalMeta(readFileSync(join(found.path, 'meta.json'), 'utf-8'));
      const skillDir = join(home, 'skills', 'agent-created', meta.skillName);
      if (existsSync(skillDir)) {
        rmSync(skillDir, { recursive: true, force: true });
      }
      moveTo('rejected', home, found);
      return chalk.green(`revoked skill ${meta.skillName} (${rest})`);
    }

    return chalk.red(`unknown proposal kind for ${rest}`);
  }

  if (verb === 'consolidate') {
    if (!ctx.reviewManager) {
      return chalk.red('review manager not available — open a session first');
    }
    ctx.reviewManager.runConsolidationPass(home);
    return chalk.dim('consolidation pass dispatched (results will appear in /review list)');
  }

  if (verb === 'activity') {
    // Query sessions for review-fork children of the current parent.
    // agentName is stored in the session title as "subagent:<agentName>"
    // by createChildSession. Filter to review-* agents.
    const parentSessionId = ctx.sessionId;

    const collectReviewChildren = () =>
      ctx
        .listSessions(50)
        .filter((s) => s.parentSessionId === parentSessionId)
        .filter((s) => /^subagent:review-/.test(s.title ?? ''));

    // Phase 13.3 follow-up — filter phantoms: rows with no tokens AND no
    // messages came from dispatches that aborted before the AgentRunner
    // streamed anything. They survived the cancellation only as DB rows.
    const splitProductive = (rows: ReturnType<typeof collectReviewChildren>) => {
      const productive = rows.filter((s) => (s.totalTokens ?? 0) > 0 || (s.msgCount ?? 0) > 0);
      return { productive, phantomCount: rows.length - productive.length };
    };

    let reviewChildrenAll = collectReviewChildren();
    let { productive, phantomCount } = splitProductive(reviewChildrenAll);

    // Phase 13.3 follow-up (Item 16) — opportunistic phantom cleanup.
    // Long-running sessions accumulate phantom rows during their own
    // lifetime, and the boot-time sweep never re-fires. Tying cleanup to
    // /review activity invocation pays the cost only when the user looks
    // at the queue. We refresh the local view post-sweep so the displayed
    // counts reflect the cleaned state.
    let cleanedThisInvocation = 0;
    if (phantomCount > PHANTOM_CLEANUP_THRESHOLD && ctx.cleanupPhantomReviews !== undefined) {
      cleanedThisInvocation = ctx.cleanupPhantomReviews();
      if (cleanedThisInvocation > 0) {
        reviewChildrenAll = collectReviewChildren();
        ({ productive, phantomCount } = splitProductive(reviewChildrenAll));
      }
    }

    const cleanedNote =
      cleanedThisInvocation > 0
        ? ` ${chalk.dim(`(cleaned ${cleanedThisInvocation} phantom row${cleanedThisInvocation === 1 ? '' : 's'})`)}`
        : '';

    if (productive.length === 0) {
      if (phantomCount > 0) {
        return (
          chalk.dim(
            `no productive review sessions for this parent (${phantomCount} phantom row${phantomCount === 1 ? '' : 's'} from cancelled dispatches)`,
          ) + cleanedNote
        );
      }
      if (cleanedThisInvocation > 0) {
        return chalk.dim('no review-fork sessions for this parent yet') + cleanedNote;
      }
      return chalk.dim('no review-fork sessions for this parent yet');
    }

    const lines = productive.slice(0, 10).map((s) => {
      const id = s.sessionId.slice(0, 8);
      const agent = (s.title ?? '?').replace(/^subagent:review-/, '');
      const time = new Date(s.lastUpdated * 1000).toISOString().replace('T', ' ').slice(0, 19);
      return `  ${chalk.dim(id)}  ${chalk.cyan(agent.padEnd(13))}  ${chalk.gray(time)}`;
    });
    const baseHeader =
      phantomCount > 0
        ? `${productive.length} review session(s) ${chalk.dim(`(+${phantomCount} phantom)`)}`
        : `${productive.length} review session(s)`;
    const header = `${baseHeader}${cleanedNote}`;
    return [chalk.bold(header), ...lines].join('\n');
  }

  return chalk.yellow(USAGE);
}

export const REVIEW_OPS_COMMANDS: SlashCommand[] = [
  {
    type: 'local',
    name: 'review',
    description: 'List, show, approve, reject, or revoke review proposals.',
    usage: '/review [list|show <id>|approve <id>|reject <id>|revoke <id>|consolidate|activity]',
    call: async (rawArgs, ctx) => handleReview(rawArgs, ctx),
  },
];
