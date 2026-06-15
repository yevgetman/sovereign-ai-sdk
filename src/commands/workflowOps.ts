// `/workflow` slash command (W4 / owner C).
//
//   /workflow list                  — list available workflows.
//   /workflow <name> [k=v ...]       — run a named workflow in the active
//                                      session, relaying its final text.
//
// Runs in the active session via a runtime-bearing capability the surface
// supplies on CommandContext: `ctx.workflows` (analogous to
// `ctx.getRoutingStats`). The capability is OPTIONAL — surfaces without a live
// runtime (sov config standalone, headless dispatch) omit it and the command
// degrades to a clear "not wired" message. The server command surface wires it
// from the runtime + loader + engine (the W7 integration seam, in
// src/server/commandContext.ts).
//
// CommandContext does not yet declare `workflows` in src/commands/types.ts
// (owned by the foundation). It is read here through a structural lens so this
// owner-scoped file stays self-contained; the seam adds the field for the
// type-checker. See `WorkflowCommandCapability` below for the exact contract.

import chalk from 'chalk';
import type { WorkflowResult } from '../workflows/engine.js';
import type { WorkflowEvent } from '../workflows/events.js';
import type { CommandContext, SlashCommand } from './types.js';

/** One workflow as surfaced by `/workflow list`. */
export type WorkflowSummary = {
  name: string;
  description: string;
  source: 'project' | 'user' | 'bundle';
  phaseCount: number;
};

/** Runtime-bearing capability the surface supplies on CommandContext so
 *  `/workflow` can list + run workflows in the active session. The server
 *  command context (buildServerCommandContext) wires it; standalone /
 *  headless surfaces omit it. Mirrors the optional `getRoutingStats` hook. */
export type WorkflowCommandCapability = {
  list: () => Promise<WorkflowSummary[]>;
  run: (
    name: string,
    args: Record<string, unknown>,
    onEvent?: (event: WorkflowEvent) => void,
  ) => Promise<WorkflowResult>;
};

/** Read the optional `workflows` capability off the context without requiring
 *  the field on the shared CommandContext type (added by the W7 seam). */
function getWorkflowCapability(ctx: CommandContext): WorkflowCommandCapability | undefined {
  return (ctx as CommandContext & { workflows?: WorkflowCommandCapability }).workflows;
}

export const WORKFLOW_OPS_COMMANDS: SlashCommand[] = [
  {
    type: 'local',
    name: 'workflow',
    description: 'List or run a declarative multi-agent workflow in this session.',
    usage: '/workflow [list | <name> [k=v ...]]',
    call: async (rawArgs, ctx) => dispatchWorkflowCommand(rawArgs, ctx),
  },
];

export async function dispatchWorkflowCommand(
  rawArgs: string,
  ctx: CommandContext,
): Promise<string> {
  const capability = getWorkflowCapability(ctx);
  if (capability === undefined) {
    return 'workflows are not wired in this surface';
  }

  const args = rawArgs.trim();
  if (args === '' || args === 'list') {
    return formatList(await capability.list());
  }

  const { name, pairs } = splitNameAndArgs(args);
  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = parseArgPairs(pairs);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  try {
    const result = await capability.run(name, parsedArgs);
    return result.finalText.trim().length > 0
      ? result.finalText
      : `workflow ${name} ${result.ok ? 'completed' : 'completed with errors'} (no final text)`;
  } catch (err) {
    return `workflow ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Split `<name> k=v k2=v2` into the workflow name and the raw `k=v` tokens. */
function splitNameAndArgs(args: string): { name: string; pairs: string[] } {
  const parts = args.split(/\s+/).filter((p) => p.length > 0);
  const name = parts[0] ?? '';
  return { name, pairs: parts.slice(1) };
}

/** Parse `k=v` tokens into a string-valued map; the engine coerces against the
 *  workflow's declared arg specs. A token with no `=` is an error so a typo
 *  never silently drops an arg. */
export function parseArgPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`invalid argument "${pair}" (expected key=value)`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function formatList(workflows: WorkflowSummary[]): string {
  if (workflows.length === 0) {
    return chalk.gray('no workflows loaded');
  }
  const sorted = [...workflows].sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.max(...sorted.map((w) => w.name.length));
  const lines = [chalk.bold(`workflows (${sorted.length})`)];
  for (const w of sorted) {
    lines.push(
      `  ${chalk.cyan(w.name.padEnd(nameWidth))}  ${chalk.gray(`[${w.source}, ${w.phaseCount} phase(s)]`)}  ${w.description}`,
    );
  }
  return lines.join('\n');
}
