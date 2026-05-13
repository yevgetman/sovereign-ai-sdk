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
  /** Phase 13: loaded sub-agent definitions. Each entry corresponds to
   *  one agent the parent can delegate to via AgentTool. The model
   *  reads this section to answer "what sub-agents do I have access
   *  to" — distinct from MCP servers (which are external tool sources)
   *  and from skills (which are markdown procedures invoked in the
   *  parent context). */
  agents: Array<{
    name: string;
    description: string;
    /** Optional trigger predicate from the agent's frontmatter (e.g.
     *  "when the user asks for an audit"). When the bundle author
     *  wrote one, surfacing it here gives the model a sharper signal
     *  than the description alone. */
    whenToUse?: string;
    /** Optional capability role; when set, the scheduler resolves the
     *  agent's provider/model through the capability profile table. */
    role?: string;
    /** Optional explicit model override; when set, the scheduler uses
     *  this literal provider/model string instead of role resolution. */
    model?: string;
    readOnly: boolean;
    maxTurns: number;
    allowedTools: string[];
    source: 'project' | 'user' | 'bundle';
    trustTier: 'builtin' | 'trusted';
  }>;
  /** Phase 12.6: per-component context-window audit. Optional — present
   *  when the snapshot getter has access to the system-prompt segments
   *  and tool pool. */
  budget?: BudgetReport;
};

const SECTIONS = ['all', 'settings', 'mcp', 'tools', 'commands', 'agents', 'budget'] as const;
type Section = (typeof SECTIONS)[number];

const inputSchema = z.object({
  section: z
    .enum(SECTIONS)
    .optional()
    .describe(
      "Which section to return. 'all' (default) returns everything. " +
        "Use 'settings', 'mcp', 'tools', 'commands', 'agents', or 'budget' to scope the output. " +
        "Use 'agents' to list loaded sub-agents (delegated via AgentTool); use 'mcp' to list " +
        'connected MCP servers (external tool sources). These are different things.',
    ),
});

type Input = z.infer<typeof inputSchema>;
type Output = Partial<HarnessInfoSnapshot>;

export function buildHarnessInfoTool(getSnapshot: () => HarnessInfoSnapshot): Tool<Input, Output> {
  return buildTool<Input, Output>({
    name: 'HarnessInfo',
    description: () =>
      'Inspect the runtime state of the harness you are running inside: permission settings layers, ' +
      'connected MCP servers and their tools, the native + MCP tool inventory, registered slash ' +
      'commands, and loaded sub-agents (delegated to via AgentTool). Call this to answer "how is the ' +
      'harness configured here", "what MCP servers are connected", "what sub-agents do I have ' +
      'access to", or "what tools / commands are available" instead of guessing. Note: "sub-agents" ' +
      'in this harness are the entries in the `agents` section (invoked via AgentTool with a ' +
      'subagent_type), NOT the MCP servers — those are external tool sources, not delegated agents.',
    inputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    renderHint: { kind: 'markdown' },
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
    case 'agents':
      return { agents: snap.agents };
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
  if (out.agents !== undefined) {
    lines.push('', `sub-agents (${out.agents.length}) — delegated via AgentTool:`);
    for (const a of out.agents) {
      const targetParts: string[] = [];
      if (a.role !== undefined) targetParts.push(`role: ${a.role}`);
      if (a.model !== undefined) targetParts.push(`model: ${a.model}`);
      const target = targetParts.length > 0 ? ` [${targetParts.join(', ')}]` : '';
      const flags = a.readOnly ? ' (read-only)' : '';
      lines.push(`  ${a.name}${target}${flags}`);
      lines.push(`    ${a.description}`);
      if (a.whenToUse !== undefined && a.whenToUse.length > 0) {
        lines.push(`    when to use: ${a.whenToUse}`);
      }
      lines.push(`    source: ${a.source} · trust: ${a.trustTier} · maxTurns: ${a.maxTurns}`);
      if (a.allowedTools.length > 0) {
        lines.push(`    allowedTools: ${a.allowedTools.join(', ')}`);
      }
    }
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
