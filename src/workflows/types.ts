// Multi-agent workflow definition schema (2026-06-15 — see
// docs/specs/2026-06-15-multi-agent-workflows-design.md).
//
// A workflow is a DECLARATIVE, deterministic multi-agent orchestration plan
// loaded as data (YAML) from project / user / bundle `workflows/` roots. The
// engine (src/workflows/engine.ts) executes it: phases run in order with a
// BARRIER between them; tasks WITHIN a phase fan out in PARALLEL (the headline
// capability), bounded by the lane semaphores + the path-lock. Outputs thread
// forward into later prompts.

import { z } from 'zod';

/** A declared workflow input. */
export const ArgSpecSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'list']),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
  })
  .strict();

/** One unit of work in a phase: delegate `prompt` to sub-agent `agent`. */
export const TaskSchema = z
  .object({
    /** A loaded sub-agent name (subagent_type); validated against the registry
     *  at load time. */
    agent: z.string().min(1),
    /** Templated prompt — {{args.X}}, {{<loopVar>}}, {{<phaseId>.text|json|results|field}}. */
    prompt: z.string().min(1),
    /** Optional cost-lane override (cheap|moderate|frontier|…); otherwise the
     *  agent's own role/provider resolution applies. */
    lane: z.string().min(1).optional(),
    /** Declared write-path globs (relative to cwd). ABSENT ⇒ the task is
     *  read-only (never takes a write lock; writes denied). PRESENT ⇒ both the
     *  path-lock scope AND an ENFORCED write boundary (writes outside are
     *  denied). `['**']` = whole tree (serializes with everything). */
    writes: z.array(z.string().min(1)).optional(),
    /** 'text' (default — the agent's final text) or 'json' (the engine parses a
     *  JSON value from the final message, with one repair retry). */
    output: z.enum(['text', 'json']).default('text'),
    /** Optional display label for progress events; defaults to the agent name. */
    label: z.string().min(1).optional(),
  })
  .strict();

/** A phase: a parallel set of fixed `tasks`, OR a `map` that fans one `task`
 *  across each element of the array `over` resolves to. Exactly one form. */
export const PhaseSchema = z
  .object({
    /** Phase id — referenced by later phases for output threading. */
    id: z.string().min(1),
    tasks: z.array(TaskSchema).min(1).optional(),
    map: z
      .object({
        /** Ref to the array to fan out over: `args.<field>` or `<phaseId>.<field>`. */
        over: z.string().min(1),
        /** Loop-variable name available in the task prompt (default `item`). */
        as: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    task: TaskSchema.optional(),
  })
  .strict()
  .superRefine((phase, ctx) => {
    const hasTasks = phase.tasks !== undefined;
    const hasMap = phase.map !== undefined;
    if (hasTasks === hasMap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `phase '${phase.id}' must have exactly one of 'tasks' or 'map'`,
      });
    }
    if (hasMap && phase.task === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `phase '${phase.id}' with 'map' requires a 'task'`,
      });
    }
    if (!hasMap && phase.task !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `phase '${phase.id}' has a top-level 'task' but no 'map' (use 'tasks' for a fixed set)`,
      });
    }
  });

export const WorkflowDefSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'workflow name must be kebab-case ([a-z0-9-])'),
    description: z.string().min(1),
    args: z.record(z.string(), ArgSpecSchema).optional(),
    phases: z.array(PhaseSchema).min(1),
  })
  .strict()
  .superRefine((def, ctx) => {
    const ids = new Set<string>();
    for (const p of def.phases) {
      if (ids.has(p.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate phase id '${p.id}'`,
        });
      }
      ids.add(p.id);
    }
  });

export type ArgSpec = z.infer<typeof ArgSpecSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;

/** A loaded workflow: the validated definition + provenance. */
export type LoadedWorkflow = {
  def: WorkflowDef;
  source: 'project' | 'user' | 'bundle';
  path: string;
};
