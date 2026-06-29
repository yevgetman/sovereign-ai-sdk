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
import type { WorkflowCommandCapability, WorkflowSummary } from '../core/workflowPort.js';
import type { CommandContext, SlashCommand } from './types.js';

// `WorkflowSummary` + `WorkflowCommandCapability` now live in open core
// (`core/workflowPort.js`) so the open command contract
// (`CommandContext.workflows`) can reference the capability shape without
// importing this proprietary command surface. Re-exported here for existing
// importers.
export type { WorkflowCommandCapability, WorkflowSummary };

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

/** Split `<name> k=v k2="multi word"` into the workflow name and the raw `k=v`
 *  tokens. Quote-aware: a `"..."` or `'...'` segment keeps its inner spaces, so
 *  a multi-word value (e.g. the `review` workflow's `diff`) survives the slash
 *  surface instead of shattering on whitespace (2026-06-15 review fix M9). */
function splitNameAndArgs(args: string): { name: string; pairs: string[] } {
  const tokens = tokenizeArgs(args);
  const name = tokens[0] ?? '';
  return { name, pairs: tokens.slice(1) };
}

/** Whitespace-split that respects single/double quotes (quotes are stripped). */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
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
