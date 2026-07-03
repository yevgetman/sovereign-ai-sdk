// Information slash commands: /about, /tools, /skills, /stats,
// /permissions, /quit, /copy. All return text — none use the picker
// primitive. The two picker-using commands (/resume, /model) live
// in src/commands/pickers.ts so this file stays free of stdin/raw
// mode coupling and can be unit-tested without a TTY.

import { spawnSync } from 'node:child_process';
import type { CommandContext, LocalCommand } from '@yevgetman/sov-sdk/commands/types';
import { formatBudgetReport } from '@yevgetman/sov-sdk/context/budget';
import { safeStaticToolDescription } from '@yevgetman/sov-sdk/tool/staticDescription';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import chalk from 'chalk';
import { boxify } from '../ui/box.js';
import { renderSessionSummary } from '../ui/sessionSummary.js';
import { VERSION as PKG_VERSION } from '../wrapperVersion.js';
import { dispatchConfigCommand } from './configOps.js';

export const aboutCommand: LocalCommand = {
  type: 'local',
  name: 'about',
  description: 'Show version, license, and current provider/model.',
  call: async (_args, ctx) => formatAbout(ctx),
};

export const toolsCommand: LocalCommand = {
  type: 'local',
  name: 'tools',
  description: 'List the tools registered in the current session.',
  call: async (_args, ctx) => formatTools(ctx),
};

export const skillsListCommand: LocalCommand = {
  type: 'local',
  name: 'skills',
  description: 'List the skills currently visible to this session.',
  call: async (_args, ctx) => formatSkills(ctx),
};

export const statsCommand: LocalCommand = {
  type: 'local',
  name: 'stats',
  description: 'Show the current session summary card (mid-session).',
  call: async (_args, ctx) => formatStats(ctx),
};

export const permissionsCommand: LocalCommand = {
  type: 'local',
  name: 'permissions',
  description: 'Show the active permission mode and any auto-allow rules.',
  call: async (_args, ctx) => formatPermissions(ctx),
};

export const expandCommand: LocalCommand = {
  type: 'local',
  name: 'expand',
  description:
    "Re-render a recent tool block with no truncation. Defaults to the most recent block; pass an index (1 = most recent, 2 = second-most-recent, …) to expand an older one. Useful when the inline renderer's '+N more lines' summary hid output you want to see.",
  usage: '/expand [N]',
  call: async (args, ctx) => {
    const trimmed = args.trim();
    let n = 1;
    if (trimmed.length > 0) {
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return 'usage: /expand [N]   (N must be a positive integer; default 1 = most recent)';
      }
      n = parsed;
    }
    const result = ctx.expandToolBlock(n);
    if (!result.ok) {
      if (result.total === 0) {
        return 'no tool blocks completed yet in this session';
      }
      return `out of range: ${n} > ${result.total} (this session has ${result.total} completed tool block${result.total === 1 ? '' : 's'})`;
    }
    // The slot wrote the expanded block directly to stdout; the
    // command itself returns an empty string so the dispatch layer
    // doesn't append a redundant trailer.
    return '';
  },
};

export const quitCommand: LocalCommand = {
  type: 'local',
  name: 'quit',
  aliases: ['exit', 'q'],
  description: 'Exit the session after printing the session summary.',
  call: async (_args, ctx) => {
    ctx.requestExit();
    return 'goodbye.';
  },
};

export const copyCommand: LocalCommand = {
  type: 'local',
  name: 'copy',
  description: 'Copy the last assistant message to the system clipboard.',
  call: async (_args, ctx) => copyLastAssistant(ctx),
};

export const settingsCommand: LocalCommand = {
  type: 'local',
  name: 'settings',
  description: 'Open the interactive settings editor (alias for /config).',
  // /settings is an alias for /config — both open the catalog-driven
  // picker through the unified dispatcher. The old raw-mode editor at
  // src/ui/configMenu.ts was removed 2026-05-24 (config UX rebuild).
  call: async (_args, ctx) => dispatchConfigCommand('', ctx),
};

export const contextBudgetCommand: LocalCommand = {
  type: 'local',
  name: 'context-budget',
  description:
    'Audit context-window usage across system prompt, tool schemas, skills, bundle, and memory.',
  call: async (_args, ctx) => formatBudgetReport(ctx.getBudgetReport()),
};

/** All info-command exports as a single array so the registry can spread
 *  them without hand-listing each command twice. */
export const INFO_COMMANDS: LocalCommand[] = [
  aboutCommand,
  toolsCommand,
  skillsListCommand,
  statsCommand,
  permissionsCommand,
  expandCommand,
  quitCommand,
  copyCommand,
  settingsCommand,
  contextBudgetCommand,
];

// ──────────────────────────────────────────────────────────────────────
// Formatters — each is exported for tests to drive without a CommandContext.
// ──────────────────────────────────────────────────────────────────────

export function formatAbout(ctx: CommandContext): string {
  const lines = [
    `${chalk.bold('Sovereign AI')} ${chalk.gray(`v${PKG_VERSION}`)}`,
    chalk.gray('Claude-Code-style harness with Hermes-pattern learning layer'),
    '',
    `${chalk.gray('provider:')}  ${ctx.providerName}`,
    `${chalk.gray('model:')}     ${ctx.model}`,
    `${chalk.gray('cwd:')}       ${ctx.cwd}`,
    `${chalk.gray('bundle:')}    ${ctx.bundlePath ?? 'no bundle (generic-agent mode)'}`,
    `${chalk.gray('session:')}   ${ctx.sessionId}`,
    '',
    chalk.gray('https://github.com/yevgetman/sovereign-ai-sdk'),
  ];
  return boxify(lines, { padding: 2 }).join('\n');
}

export function formatTools(ctx: CommandContext): string {
  if (ctx.tools.length === 0) return 'no tools registered for this session.';
  const sorted = [...ctx.tools].sort((a, b) => a.name.localeCompare(b.name));
  const labelWidth = Math.max(...sorted.map((t) => t.name.length));
  const lines: string[] = [chalk.bold(`tools (${sorted.length})`), ''];
  for (const tool of sorted) {
    const padded = tool.name.padEnd(labelWidth, ' ');
    const desc = describeTool(tool);
    lines.push(`  ${chalk.cyan(padded)}  ${chalk.gray(desc)}`);
  }
  return lines.join('\n');
}

/** Synchronously describe a tool for the /tools listing. Delegates to the SDK's
 *  shared `safeStaticToolDescription`, the single guard for resolving a
 *  `(input) => string | Promise<string>` description in a synchronous context:
 *  it degrades a throwing / async / non-string description to the tool name and
 *  — critically — attaches a no-op `.catch()` to any returned Promise so an
 *  async-REJECTING description can never surface as an unhandled rejection that
 *  crashes the process (the class the SDK closed at its four static call sites;
 *  this render helper is the fifth). We keep only the first line for the listing. */
function describeTool(tool: Tool<unknown, unknown>): string {
  return safeStaticToolDescription(tool).split('\n')[0] ?? '';
}

export function formatSkills(ctx: CommandContext): string {
  const skills = ctx.skills.skills;
  if (skills.length === 0) return 'no skills loaded for this session.';
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const labelWidth = Math.max(...sorted.map((s) => s.name.length));
  const lines: string[] = [chalk.bold(`skills (${sorted.length})`), ''];
  for (const skill of sorted) {
    const padded = skill.name.padEnd(labelWidth, ' ');
    const sourceTag = chalk.gray(`[${skill.source}]`);
    lines.push(`  ${chalk.cyan(padded)}  ${sourceTag}  ${skill.description}`);
  }
  return lines.join('\n');
}

export function formatStats(ctx: CommandContext): string {
  const m = ctx.getMetrics();
  const cost = ctx.getCost();
  return renderSessionSummary({
    ...m,
    endedAtMs: Date.now(),
    tokens: {
      input: cost.inputTokens + cost.compactionInputTokens,
      output: cost.outputTokens + cost.compactionOutputTokens,
      cacheRead: cost.cacheReadInputTokens,
      cacheWrite: cost.cacheCreationInputTokens,
      estimatedCostUsd: cost.estimatedCostUsd + cost.estimatedCompactionCostUsd,
    },
  });
}

export function formatPermissions(ctx: CommandContext): string {
  const { mode, alwaysAllow, layers } = ctx.getPermissions();
  const lines: string[] = [chalk.bold('permissions'), ''];
  lines.push(`${chalk.gray('mode:')}  ${formatMode(mode)}`);
  lines.push('');
  if (alwaysAllow.length > 0) {
    lines.push(chalk.bold(`session always-allow (${alwaysAllow.length})`));
    for (const rule of alwaysAllow) lines.push(`  ${chalk.green('✓')} ${rule}`);
    lines.push('');
  }
  let totalLayerRules = 0;
  for (const layer of layers) totalLayerRules += layer.rules.length;
  if (totalLayerRules > 0) {
    lines.push(chalk.bold(`persistent rules (${totalLayerRules})`));
    for (const layer of layers) {
      if (layer.rules.length === 0) continue;
      lines.push(`  ${chalk.gray(`from ${layer.source}:`)}`);
      for (const rule of layer.rules)
        lines.push(`    ${formatRuleBehavior(rule.behavior)} ${rule.raw}`);
    }
  } else {
    lines.push(chalk.gray('no persistent allow/deny rules loaded.'));
  }
  return lines.join('\n');
}

function formatMode(mode: 'default' | 'ask' | 'bypass'): string {
  if (mode === 'bypass') return chalk.red('bypass (fallthrough auto-allows)');
  if (mode === 'ask') return chalk.yellow('ask (every fallthrough prompts)');
  return chalk.green('default (tool self-checks decide)');
}

function formatRuleBehavior(behavior: 'allow' | 'deny' | 'ask'): string {
  if (behavior === 'allow') return chalk.green('+');
  if (behavior === 'deny') return chalk.red('-');
  return chalk.yellow('?');
}

export function copyLastAssistant(ctx: CommandContext): string {
  const text = ctx.getLastAssistantText();
  if (text === null) {
    return 'no assistant text available to copy yet.';
  }
  const result = writeClipboard(text);
  if (result.ok) return `copied ${text.length} chars via ${result.tool}.`;
  return `clipboard tool not available (tried: ${result.attempted.join(', ')}). assistant text:\n\n${text}`;
}

type ClipboardResult = { ok: true; tool: string } | { ok: false; attempted: string[] };

function writeClipboard(text: string): ClipboardResult {
  const candidates: { tool: string; cmd: string; args: string[] }[] = [
    { tool: 'pbcopy', cmd: 'pbcopy', args: [] },
    { tool: 'wl-copy', cmd: 'wl-copy', args: [] },
    { tool: 'xclip', cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { tool: 'xsel', cmd: 'xsel', args: ['--clipboard', '--input'] },
    { tool: 'clip.exe', cmd: 'clip.exe', args: [] },
  ];
  const attempted: string[] = [];
  for (const candidate of candidates) {
    attempted.push(candidate.tool);
    try {
      const result = spawnSync(candidate.cmd, candidate.args, {
        input: text,
        encoding: 'utf8',
        timeout: 2000,
      });
      // ENOENT manifests as result.error; status 0 means the tool ran.
      if (!result.error && result.status === 0) {
        return { ok: true, tool: candidate.tool };
      }
    } catch {
      // Continue to next candidate.
    }
  }
  return { ok: false, attempted };
}
