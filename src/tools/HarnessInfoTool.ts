// HarnessInfoTool — runtime introspection. The model calls it to answer
// meta-questions about the harness it's running in: what settings layers
// are loaded, what MCP servers are connected, what tools are available,
// what slash commands the user has access to.
//
// Pairs with the `<harness-self-doc>` segment in the system prompt: the
// prompt teaches the *contracts* (settings paths, schemas, command names);
// this tool exposes the *current state*. Together they let the agent
// answer "how do I configure X" and "what's already set up here" without
// web search or guessing.
//
// Closure-injected (mirrors ToolSearchTool): the factory takes a snapshot
// getter; terminalRepl supplies the getter after wiring is complete (the
// snapshot needs the live MCP pool and the post-assembly tool pool, so it
// can't be captured eagerly).

import { z } from 'zod';
import { type BudgetReport, formatBudgetReport } from '../context/budget.js';
import { buildTool } from '../tool/buildTool.js';
import type { Tool } from '../tool/types.js';

export type HarnessInfoSnapshot = {
  permissionMode: 'default' | 'ask' | 'bypass';
  settingsLayers: Array<{
    name: 'local' | 'project' | 'user';
    path: string;
    present: boolean;
  }>;
  mcpServers: Array<{
    name: string;
    command: string;
    args: string[];
    status: 'connected' | 'failed' | 'not-attempted';
    toolCount: number;
    tools: string[];
  }>;
  tools: {
    native: string[];
    mcp: string[];
  };
  slashCommands: Array<{ name: string; description: string }>;
  /** Phase 12.6: per-component context-window audit. Optional — present
   *  when the snapshot getter has access to the system-prompt segments
   *  and tool pool. */
  budget?: BudgetReport;
};

const SECTIONS = ['all', 'settings', 'mcp', 'tools', 'commands', 'budget'] as const;
type Section = (typeof SECTIONS)[number];

const inputSchema = z.object({
  section: z
    .enum(SECTIONS)
    .optional()
    .describe(
      "Which section to return. 'all' (default) returns everything. " +
        "Use 'settings', 'mcp', 'tools', or 'commands' to scope the output.",
    ),
});

type Input = z.infer<typeof inputSchema>;
type Output = Partial<HarnessInfoSnapshot>;

export function buildHarnessInfoTool(getSnapshot: () => HarnessInfoSnapshot): Tool<Input, Output> {
  return buildTool<Input, Output>({
    name: 'HarnessInfo',
    description: () =>
      'Inspect the runtime state of the harness you are running inside: permission settings layers, ' +
      'connected MCP servers and their tools, the native + MCP tool inventory, and registered slash ' +
      'commands. Call this to answer "how is the harness configured here", "what MCP servers are ' +
      'connected", or "what tools / commands are available" instead of guessing.',
    inputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    async call(input) {
      const snap = getSnapshot();
      const section = input.section ?? 'all';
      return {
        data: filterSnapshot(snap, section),
        observation: {
          status: 'success',
          summary: `runtime snapshot (${section})`,
        },
      };
    },
    renderResult: (out) => ({ content: formatSnapshot(out) }),
  });
}

function filterSnapshot(snap: HarnessInfoSnapshot, section: Section): Output {
  switch (section) {
    case 'settings':
      return { permissionMode: snap.permissionMode, settingsLayers: snap.settingsLayers };
    case 'mcp':
      return { mcpServers: snap.mcpServers };
    case 'tools':
      return { tools: snap.tools };
    case 'commands':
      return { slashCommands: snap.slashCommands };
    case 'budget':
      return snap.budget !== undefined ? { budget: snap.budget } : {};
    default:
      return snap;
  }
}

function formatSnapshot(out: Output): string {
  const lines: string[] = [];
  if (out.permissionMode !== undefined) {
    lines.push(`permissionMode: ${out.permissionMode}`);
  }
  if (out.settingsLayers !== undefined) {
    lines.push('', 'settings layers (highest precedence first):');
    for (const layer of out.settingsLayers) {
      lines.push(`  ${layer.name}: ${layer.path} ${layer.present ? '(present)' : '(absent)'}`);
    }
  }
  if (out.mcpServers !== undefined) {
    lines.push('', `mcp servers: ${out.mcpServers.length}`);
    for (const s of out.mcpServers) {
      const argSuffix = s.args.length > 0 ? ` ${s.args.join(' ')}` : '';
      const toolPreview =
        s.tools.length > 5 ? `${s.tools.slice(0, 5).join(', ')}, ...` : s.tools.join(', ');
      lines.push(`  ${s.name}: ${s.status}, ${s.toolCount} tools (${toolPreview})`);
      lines.push(`    command: ${s.command}${argSuffix}`);
    }
  }
  if (out.tools !== undefined) {
    lines.push('', `native tools (${out.tools.native.length}):`);
    if (out.tools.native.length > 0) lines.push(`  ${out.tools.native.join(', ')}`);
    lines.push(`mcp tools (${out.tools.mcp.length}):`);
    if (out.tools.mcp.length > 0) lines.push(`  ${out.tools.mcp.join(', ')}`);
  }
  if (out.budget !== undefined) {
    lines.push('', formatBudgetReport(out.budget));
  }
  if (out.slashCommands !== undefined) {
    lines.push('', `slash commands (${out.slashCommands.length}):`);
    for (const c of out.slashCommands) {
      lines.push(`  /${c.name} — ${c.description}`);
    }
  }
  return lines.join('\n').trim();
}
