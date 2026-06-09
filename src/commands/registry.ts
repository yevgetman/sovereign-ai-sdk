// Slash-command registry and dispatcher. This stays UI-agnostic: readline,
// future Ink, Telegram, and Slack surfaces should all use this registry
// rather than re-declaring command lists.

import chalk from 'chalk';
import { formatUsd } from '../providers/pricing.js';
import { visibleWidth } from '../ui/box.js';
import { dispatchConfigCommand } from './configOps.js';
import { INFO_COMMANDS } from './info.js';
import { PICKER_COMMANDS } from './pickers.js';
import { PLUGIN_OPS_COMMANDS } from './pluginOps.js';
import { REVIEW_OPS_COMMANDS } from './reviewOps.js';
import { routingStatsCommand } from './routingStats.js';
import { SESSION_OPS_COMMANDS } from './sessionOps.js';
import { TASK_OPS_COMMANDS } from './taskOps.js';
import type { CommandContext, CommandDispatchResult, SlashCommand } from './types.js';

/** Static category labels for /help. Skill-generated commands fall into
 *  the "skills" bucket; everything else is keyed off the command name. */
const COMMAND_CATEGORIES: Record<string, string> = {
  help: 'session',
  clear: 'session',
  cost: 'session',
  compact: 'session',
  rollback: 'session',
  resume: 'session',
  stats: 'session',
  'routing-stats': 'session',
  quit: 'session',
  // info
  about: 'info',
  tools: 'info',
  skills: 'info',
  permissions: 'info',
  expand: 'info',
  'context-budget': 'info',
  tasks: 'session',
  review: 'session',
  continue: 'session',
  // model + config
  model: 'config',
  config: 'config',
  settings: 'config',
  theme: 'config',
  plugins: 'config',
  // file/session ops
  export: 'files',
  init: 'files',
  copy: 'files',
  // git
  commit: 'git',
};

const CATEGORY_ORDER = ['session', 'info', 'config', 'files', 'git', 'skills', 'other'] as const;
type Category = (typeof CATEGORY_ORDER)[number];

export const COMMANDS: SlashCommand[] = [
  {
    type: 'local',
    name: 'help',
    aliases: ['h', '?'],
    description: 'List available slash commands.',
    call: async (_args, ctx) => formatHelp(ctx.registry),
  },
  {
    type: 'local',
    name: 'clear',
    description: 'Clear conversation history by starting a fresh child session.',
    call: async (_args, ctx) => ctx.clearHistory(),
  },
  {
    type: 'local',
    name: 'cost',
    description: 'Show token usage and estimated cost for this session.',
    call: async (_args, ctx) => formatCost(ctx),
  },
  {
    type: 'local',
    name: 'compact',
    description: 'Compress this conversation into a new child session with rollback lineage.',
    call: async (_args, ctx) => {
      const result = await ctx.compact();
      // Backlog #36: a no-op result means the entire history fit within the
      // tail budget — there was nothing to summarize. Surface a friendlier
      // message so the user knows the call succeeded (no error) but no
      // child session was minted, no rollback target exists, and the
      // session id stays on the parent.
      if (result.noOp === true) {
        return [
          'nothing to compact: the conversation already fits within the tail budget',
          `current session preserved: ${result.parentSessionId}`,
        ].join('\n');
      }
      const aux = result.usedAuxiliary
        ? `aux=${result.auxiliaryProvider ?? 'unknown'}/${result.auxiliaryModel ?? 'unknown'}`
        : 'aux=fallback';
      return [
        `compacted session: ${result.parentSessionId} -> ${result.newSessionId}`,
        `messages compacted: ${result.compactedMessages}`,
        `estimated tokens: ${result.estimatedBeforeTokens} -> ${result.estimatedAfterTokens}`,
        aux,
        'rollback: /rollback',
      ].join('\n');
    },
  },
  {
    type: 'local',
    name: 'rollback',
    description: 'Switch back to the parent session after /compact.',
    call: async (_args, ctx) => ctx.rollback(),
  },
  {
    type: 'local',
    name: 'continue',
    description: 'Resume a turn paused by the tool-call checkin limit.',
    call: async (_args, ctx) => {
      if (!ctx.resumeCheckin) return 'no pending checkin';
      await ctx.resumeCheckin();
      return '';
    },
  },
  ...PICKER_COMMANDS,
  ...INFO_COMMANDS,
  ...SESSION_OPS_COMMANDS,
  ...TASK_OPS_COMMANDS,
  ...REVIEW_OPS_COMMANDS,
  ...PLUGIN_OPS_COMMANDS,
  routingStatsCommand,
  {
    type: 'local',
    name: 'config',
    description: 'View or change durable user-level config (~/.harness/config.json).',
    usage:
      '/config [<group-id>|edit <dotpath>|set <dotpath> <value>|unset <dotpath>|show|path|get <dotpath>]',
    call: async (args, ctx) => dispatchConfigCommand(args, ctx),
  },
  {
    type: 'prompt',
    name: 'commit',
    description: 'Ask the model to stage changes, write a commit message, and commit.',
    allowedTools: [
      'Bash(git status)',
      'Bash(git status **)',
      'Bash(git diff)',
      'Bash(git diff **)',
      'Bash(git diff --staged)',
      'Bash(git diff --staged **)',
      'Bash(git add **)',
      'Bash(git commit **)',
    ],
    getPromptForCommand: async (args, ctx) => {
      const extra = args.trim() ? ` Additional user instruction: ${args.trim()}` : '';
      return [
        {
          type: 'text',
          text: `Stage the relevant changes, write a concise commit message that explains why, and commit from the current working directory: ${ctx.cwd}. The shell already starts in that directory. Do not use cd, pushd, git -C, subshells, pipes, or chained commands. Use only direct git status, git diff, git add, and git commit operations.${extra}`,
        },
      ];
    },
  },
];

export const COMMAND_REGISTRY = buildCommandRegistry(COMMANDS);

export async function dispatchSlashCommand(
  rawInput: string,
  ctx: CommandContext,
): Promise<CommandDispatchResult> {
  const parsed = parseSlashCommand(rawInput);
  if (!parsed) return { kind: 'unknown', output: 'not a slash command' };
  const command = ctx.registry.get(parsed.name);
  if (!command) {
    return {
      kind: 'unknown',
      output: `unknown command: /${parsed.name}\n\n${formatHelp(ctx.registry)}`,
    };
  }

  if (command.type === 'prompt') {
    return {
      kind: 'prompt',
      command,
      content: await command.getPromptForCommand(parsed.args, ctx),
    };
  }
  if (command.type === 'local-jsx') {
    const out = await command.call(parsed.args, ctx);
    return { kind: 'local', output: typeof out === 'string' ? out : JSON.stringify(out, null, 2) };
  }
  return { kind: 'local', output: await command.call(parsed.args, ctx) };
}

export function parseSlashCommand(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const withoutSlash = trimmed.slice(1).trim();
  if (!withoutSlash) return { name: '', args: '' };
  const firstSpace = withoutSlash.search(/\s/);
  if (firstSpace === -1) return { name: withoutSlash, args: '' };
  return {
    name: withoutSlash.slice(0, firstSpace),
    args: withoutSlash.slice(firstSpace + 1).trim(),
  };
}

export function buildCommandRegistry(commands: SlashCommand[]): Map<string, SlashCommand> {
  const registry = new Map<string, SlashCommand>();
  for (const command of commands) {
    if (!registry.has(command.name)) registry.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      if (!registry.has(alias)) registry.set(alias, command);
    }
  }
  return registry;
}

function formatHelp(registry: ReadonlyMap<string, SlashCommand>): string {
  const unique = Array.from(new Set(registry.values()));
  const grouped = new Map<Category, SlashCommand[]>();
  for (const command of unique) {
    const category = categoryFor(command);
    const list = grouped.get(category) ?? [];
    list.push(command);
    grouped.set(category, list);
  }

  const sections: string[] = [];
  sections.push(chalk.bold('slash commands'));
  for (const category of CATEGORY_ORDER) {
    const commands = grouped.get(category);
    if (!commands || commands.length === 0) continue;
    commands.sort((a, b) => a.name.localeCompare(b.name));
    const heads = commands.map((c) => `/${c.name}${aliasSuffix(c)}`);
    const labelWidth = Math.max(...heads.map((h) => visibleWidth(h)));
    const rows: string[] = [];
    rows.push('');
    rows.push(chalk.gray(`── ${category} ──`));
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      const head = heads[i] ?? '';
      if (!command) continue;
      const pad = ' '.repeat(Math.max(0, labelWidth - visibleWidth(head)));
      rows.push(`  ${chalk.cyan(head)}${pad}  ${chalk.gray(command.description)}`);
      if (command.usage) {
        rows.push(`  ${' '.repeat(labelWidth)}  ${chalk.dim(command.usage)}`);
      }
    }
    sections.push(rows.join('\n'));
  }
  sections.push('');
  sections.push(chalk.dim('hint: type / followed by a name. Press Tab to autocomplete.'));
  return sections.join('\n');
}

function categoryFor(command: SlashCommand): Category {
  const explicit = COMMAND_CATEGORIES[command.name];
  if (explicit) return explicit as Category;
  if (command.type === 'prompt') return 'skills';
  return 'other';
}

function aliasSuffix(command: SlashCommand): string {
  if (!command.aliases || command.aliases.length === 0) return '';
  return chalk.dim(` (${command.aliases.map((a) => `/${a}`).join(' ')})`);
}

function formatCost(ctx: CommandContext): string {
  const cost = ctx.getCost();
  const totalTokens =
    cost.inputTokens +
    cost.outputTokens +
    cost.cacheCreationInputTokens +
    cost.cacheReadInputTokens +
    cost.compactionInputTokens +
    cost.compactionOutputTokens;
  const estimatedTotalCost = cost.estimatedCostUsd + cost.estimatedCompactionCostUsd;
  return [
    `session: ${ctx.sessionId}`,
    `provider/model: ${ctx.providerName} / ${ctx.model}`,
    `tokens: total=${totalTokens}, input=${cost.inputTokens}, output=${cost.outputTokens}, cache_write=${cost.cacheCreationInputTokens}, cache_read=${cost.cacheReadInputTokens}`,
    `compaction tokens: input=${cost.compactionInputTokens}, output=${cost.compactionOutputTokens}`,
    `estimated cost: ${formatUsd(estimatedTotalCost)} (chat ${formatUsd(cost.estimatedCostUsd)}, compaction ${formatUsd(cost.estimatedCompactionCostUsd)})`,
  ].join('\n');
}
