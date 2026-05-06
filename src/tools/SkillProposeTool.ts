// Phase 13.3 — skill_propose tool. Used by review sub-agents to file a
// pending skill proposal as a directory under
// $HARNESS_HOME/review/pending/skills/<id>/ with a meta.json provenance
// sidecar and a ready-to-copy SKILL.md. The /review approve slash command
// (later in Phase 13.3) copies SKILL.md to skills/agent-created/<name>/.
// Excluded from SUBAGENT_EXCLUDED_TOOLS so review forks cannot recurse.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { hashSource, newProposalId } from '../review/idHelpers.js';
import { ensureReviewDirs, skillProposalDir } from '../review/paths.js';
import { type SkillProposalMeta, serializeSkillProposalMeta } from '../review/proposal.js';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';

const SkillProposeInputSchema = z.object({
  skillName: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'skillName must match /^[A-Za-z][A-Za-z0-9_-]*$/'),
  description: z.string().min(1).max(500),
  whenToUse: z.string().min(1).max(500),
  body: z.string().min(1),
  sourceMessageRange: z.tuple([z.number(), z.number()]),
  sourceExcerpt: z.string(),
  traceId: z.string().min(1),
});

export type SkillProposeInput = z.infer<typeof SkillProposeInputSchema>;

export interface SkillProposeOutput {
  proposalId: string;
  path: string;
}

function buildSkillFile(input: SkillProposeInput): string {
  const frontmatter = stringifyYaml({
    name: input.skillName,
    description: input.description,
    whenToUse: input.whenToUse,
  });
  return `---\n${frontmatter}---\n${input.body}`;
}

/** Phase 13.3 follow-up (C2) — build a SKILL.md with a provenance comment
 *  injected between the frontmatter and the body. Mirrors the memory auto-
 *  promote path so audit tooling can trace auto-promoted skills back to their
 *  origin session, trace event, and source excerpt. */
function buildSkillFileWithProvenance(
  input: SkillProposeInput,
  proposalId: string,
  sourceHash: string,
  sessionId: string,
): string {
  const frontmatter = stringifyYaml({
    name: input.skillName,
    description: input.description,
    whenToUse: input.whenToUse,
  });
  const provenance = [
    `proposal:${proposalId}`,
    'auto-promoted',
    `session:${sessionId}`,
    `trace:${input.traceId}`,
    `hash:${sourceHash}`,
    `range:${input.sourceMessageRange[0]}-${input.sourceMessageRange[1]}`,
    `excerpt:${escapeForHtmlComment(input.sourceExcerpt)}`,
  ];
  return `---\n${frontmatter}---\n<!-- ${provenance.join(' ')} -->\n${input.body}`;
}

/** Sanitize a string for safe embedding inside an HTML comment.
 *  HTML comments must not contain '--'. Replace any double-dash with a
 *  single dash, then truncate long excerpts to 200 chars. The hash field
 *  provides full integrity — the excerpt is for human readability only. */
function escapeForHtmlComment(s: string): string {
  const safe = s.replace(/--/g, '-');
  return safe.length > 200 ? `${safe.slice(0, 200)}...` : safe;
}

export const SkillProposeTool = buildTool<SkillProposeInput, SkillProposeOutput>({
  name: 'skill_propose',
  searchHint: 'Propose a new reusable skill for human review.',
  description: () =>
    [
      'Propose a new reusable skill for human review.',
      'Skills are heavy artifacts — only propose when the workflow is clearly reusable and non-trivial.',
      'Used by review sub-agents only.',
      'Writes to $HARNESS_HOME/review/pending/skills/<id>/{meta.json, SKILL.md}.',
    ].join(' '),
  inputSchema: SkillProposeInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const home = ctx.harnessHome;
    if (!home) {
      throw new Error('skill_propose: harnessHome not configured in tool context');
    }

    const proposalId = newProposalId();
    const sourceHash = hashSource(input.sourceExcerpt, input.sourceMessageRange);

    if (ctx.reviewAutoPromoteSkills === true) {
      const skillDir = join(home, 'skills', 'agent-created', input.skillName);
      mkdirSync(skillDir, { recursive: true });
      const skillPath = join(skillDir, 'SKILL.md');
      // Phase 13.3 follow-up (C2) — embed full provenance comment so audit
      // tooling can trace auto-promoted skills back to their origin.
      writeFileSync(
        skillPath,
        buildSkillFileWithProvenance(input, proposalId, sourceHash, ctx.sessionId),
      );
      return {
        data: { proposalId, path: skillDir },
        observation: {
          status: 'success',
          summary: `auto-promoted skill ${input.skillName}`,
          artifacts: [`skill:${input.skillName}`],
        },
      };
    }

    // TODO(phase 13.3+): thread parentSessionId from AgentRunner so child
    //   sessions populate it; null is correct for v0.
    const meta: SkillProposalMeta = {
      proposalId,
      type: 'skill',
      skillName: input.skillName,
      sessionId: ctx.sessionId,
      parentSessionId: null,
      traceId: input.traceId,
      sourceMessageRange: input.sourceMessageRange,
      sourceHash,
      sourceExcerpt: input.sourceExcerpt,
      author: 'review-skill',
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    ensureReviewDirs(home);
    const dir = skillProposalDir(home, 'pending', proposalId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), serializeSkillProposalMeta(meta));
    writeFileSync(join(dir, 'SKILL.md'), buildSkillFile(input));

    return {
      data: { proposalId, path: dir },
      observation: {
        status: 'success',
        summary: `skill proposal ${proposalId} pending review (skill: ${input.skillName})`,
        artifacts: [`review:skill:${proposalId}`],
        next_actions: [
          `/review show ${proposalId}`,
          `/review approve ${proposalId}`,
          `/review reject ${proposalId}`,
        ],
      },
    };
  },
}) as unknown as Tool<unknown, unknown>;
