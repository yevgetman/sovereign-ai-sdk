// Slash-command registry and dispatcher. This stays UI-agnostic: readline,
// future Ink, Telegram, and Slack surfaces should all use this registry
// rather than re-declaring command lists.

import {
  formatValue,
  getAt,
  parseValueLiteral,
  readConfig,
  redactSecrets,
  resolveConfigPath,
  setAt,
  unsetAt,
  writeConfig,
} from '../config/store.js';
import { formatUsd } from '../providers/pricing.js';
import type { CommandContext, CommandDispatchResult, SlashCommand } from './types.js';

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
    name: 'model',
    description: 'Switch the active model for the next turn.',
    usage: '/model <name>',
    call: async (args, ctx) => {
      const next = args.trim();
      if (!next) return `current model: ${ctx.model}`;
      ctx.setModel(next);
      return `model set to ${next}`;
    },
  },
  {
    type: 'local',
    name: 'config',
    description: 'View or change durable user-level config (~/.harness/config.json).',
    usage: '/config [show|path|get <dotpath>|set <dotpath> <value>|unset <dotpath>]',
    call: async (args, _ctx) => handleConfigCommand(args),
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
  const unique = Array.from(new Set(registry.values())).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const lines = ['available commands:'];
  for (const command of unique) {
    const aliases = command.aliases?.length ? ` (aliases: ${command.aliases.join(', ')})` : '';
    lines.push(`/${command.name}${aliases} — ${command.description}`);
    if (command.usage) lines.push(`  usage: ${command.usage}`);
  }
  return lines.join('\n');
}

function handleConfigCommand(rawArgs: string): string {
  const trimmed = rawArgs.trim();
  if (!trimmed || trimmed === 'show') {
    const settings = readConfig();
    return JSON.stringify(redactSecrets(settings), null, 2);
  }
  const firstSpace = trimmed.search(/\s/);
  const verb = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  try {
    if (verb === 'path') return resolveConfigPath();
    if (verb === 'get') {
      if (!rest) return 'usage: /config get <dotpath>';
      const settings = readConfig();
      return formatValue(getAt(redactSecrets(settings), rest));
    }
    if (verb === 'set') {
      const split = rest.search(/\s/);
      if (split === -1) return 'usage: /config set <dotpath> <value>';
      const dotpath = rest.slice(0, split);
      const value = parseValueLiteral(rest.slice(split + 1).trim());
      const next = setAt(readConfig(), dotpath, value);
      writeConfig(next);
      return `set ${dotpath}`;
    }
    if (verb === 'unset') {
      if (!rest) return 'usage: /config unset <dotpath>';
      const next = unsetAt(readConfig(), rest);
      writeConfig(next);
      return `unset ${rest}`;
    }
    return `unknown /config verb: ${verb}\nusage: /config [show|path|get <dotpath>|set <dotpath> <value>|unset <dotpath>]`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `config error: ${msg}`;
  }
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
