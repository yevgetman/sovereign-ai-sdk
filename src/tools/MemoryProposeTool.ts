// Phase 13.3 — memory_propose tool. Used by review sub-agents to file
// pending memory proposals to $HARNESS_HOME/review/pending/memory/.
// The /review approve slash command later promotes them into MEMORY.md or
// USER.md. Excluded from SUBAGENT_EXCLUDED_TOOLS so review forks cannot
// recurse.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { hashSource, newProposalId } from '../review/idHelpers.js';
import { ensureReviewDirs, proposalPath } from '../review/paths.js';
import { type MemoryProposal, serializeMemoryProposal } from '../review/proposal.js';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';

const MemoryProposeInputSchema = z.object({
  target: z.enum(['MEMORY.md', 'USER.md']),
  memoryType: z.enum(['user', 'feedback', 'project', 'reference']),
  body: z.string().min(1),
  sourceMessageRange: z.tuple([z.number(), z.number()]),
  sourceExcerpt: z.string(),
  traceId: z.string().min(1),
});

export type MemoryProposeInput = z.infer<typeof MemoryProposeInputSchema>;

export interface MemoryProposeOutput {
  proposalId: string;
  path: string;
}

export const MemoryProposeTool = buildTool<MemoryProposeInput, MemoryProposeOutput>({
  name: 'memory_propose',
  searchHint: 'Propose a durable memory entry for human review.',
  description: () =>
    [
      'Propose a durable memory entry (preferences, project facts, references) for human review.',
      'Used by review sub-agents only — never by the main agent.',
      'The proposal is written to $HARNESS_HOME/review/pending/memory/ and shown via /review list.',
    ].join(' '),
  inputSchema: MemoryProposeInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const home = ctx.harnessHome;
    if (!home) {
      throw new Error('memory_propose: harnessHome not configured in tool context');
    }

    const proposalId = newProposalId();
    const sourceHash = hashSource(input.sourceExcerpt, input.sourceMessageRange);

    if (ctx.reviewAutoPromoteMemory === true) {
      const memDir = join(home, 'memory');
      mkdirSync(memDir, { recursive: true });
      const target = join(memDir, input.target);
      // Phase 13.3 follow-up (C2) — preserve full provenance even on the
      // auto-promote bypass path. The HTML comment is invisible in rendered
      // markdown but lets /review tooling and audit scripts trace this
      // entry back to its origin session, trace event, and source excerpt.
      const provenanceFields = [
        `proposal:${proposalId}`,
        'auto-promoted',
        `session:${ctx.sessionId}`,
        `trace:${input.traceId}`,
        `hash:${sourceHash}`,
        `range:${input.sourceMessageRange[0]}-${input.sourceMessageRange[1]}`,
        `excerpt:${escapeForHtmlComment(input.sourceExcerpt)}`,
      ];
      const block = `\n\n<!-- ${provenanceFields.join(' ')} -->\n${input.body}\n`;
      if (existsSync(target)) {
        appendFileSync(target, block);
      } else {
        writeFileSync(target, block.trimStart());
      }
      return {
        data: { proposalId, path: target },
        observation: {
          status: 'success',
          summary: `auto-promoted memory entry to ${input.target}`,
          artifacts: [`memory:${input.target}`],
        },
      };
    }

    // TODO(phase 13.3+): thread parentSessionId from AgentRunner so child
    //   sessions populate it; null is correct for v0 since main-session
    //   propose calls have no parent.
    const proposal: MemoryProposal = {
      proposalId,
      type: 'memory',
      target: input.target,
      memoryType: input.memoryType,
      sessionId: ctx.sessionId,
      parentSessionId: null,
      traceId: input.traceId,
      sourceMessageRange: input.sourceMessageRange,
      sourceHash,
      sourceExcerpt: input.sourceExcerpt,
      author: 'review-memory',
      createdAt: new Date().toISOString(),
      status: 'pending',
      body: input.body,
    };

    ensureReviewDirs(home);
    const dest = proposalPath(home, 'pending', 'memory', proposalId);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, serializeMemoryProposal(proposal));

    return {
      data: { proposalId, path: dest },
      observation: {
        status: 'success',
        summary: `memory proposal ${proposalId} pending review`,
        artifacts: [`review:memory:${proposalId}`],
        next_actions: [
          `/review show ${proposalId}`,
          `/review approve ${proposalId}`,
          `/review reject ${proposalId}`,
        ],
      },
    };
  },
}) as unknown as Tool<unknown, unknown>;

/** Sanitize a string for safe embedding inside an HTML comment.
 *  HTML comments must not contain '--'. Replace any double-dash with a
 *  single dash, then truncate long excerpts to 200 chars. The hash field
 *  provides full integrity — the excerpt is for human readability only. */
function escapeForHtmlComment(s: string): string {
  const safe = s.replace(/--/g, '-');
  return safe.length > 200 ? `${safe.slice(0, 200)}...` : safe;
}
