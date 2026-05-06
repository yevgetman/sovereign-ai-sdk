// Phase 13.3 — memory_propose tool. Used by review sub-agents to file
// pending memory proposals to $HARNESS_HOME/review/pending/memory/.
// The /review approve slash command later promotes them into MEMORY.md or
// USER.md. Excluded from SUBAGENT_EXCLUDED_TOOLS so review forks cannot
// recurse.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ensureReviewDirs, proposalPath } from '../review/paths.js';
import { type MemoryProposal, serializeMemoryProposal } from '../review/proposal.js';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';

const MemoryProposeInputSchema = z.object({
  target: z.enum(['MEMORY.md', 'USER.md']),
  memoryType: z.enum(['user', 'feedback', 'project', 'reference']),
  title: z.string().min(1),
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

function newProposalId(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${randomBytes(4).toString('hex')}`;
}

function hashSource(excerpt: string, range: readonly [number, number]): string {
  const h = createHash('sha256');
  h.update(`${range[0]}:${range[1]}:${excerpt}`);
  return `sha256:${h.digest('hex')}`;
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
