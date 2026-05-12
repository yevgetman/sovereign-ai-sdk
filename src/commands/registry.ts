// Slash-command registry + dispatcher. UI-agnostic — every surface
// (Ink TUI, future Telegram, Slack) uses this single source of truth.

import chalk from 'chalk';
import type {
  CommandContext,
  CommandDispatchResult,
  CommandRegistry,
  LocalCommand,
  SlashCommand,
} from './types.js';

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

export function buildCommandRegistry(commands: ReadonlyArray<SlashCommand>): CommandRegistry {
  const registry = new Map<string, SlashCommand>();
  for (const command of commands) {
    if (!registry.has(command.name)) registry.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      if (!registry.has(alias)) registry.set(alias, command);
    }
  }
  return registry;
}

export async function dispatchSlashCommand(
  rawInput: string,
  ctx: CommandContext,
): Promise<CommandDispatchResult> {
  const parsed = parseSlashCommand(rawInput);
  if (!parsed) return { kind: 'unknown', output: 'not a slash command' };
  if (!parsed.name) {
    return { kind: 'unknown', output: 'empty command\n\ntype /help to list available commands' };
  }
  const command = ctx.registry.get(parsed.name);
  if (!command) {
    return {
      kind: 'unknown',
      output: `unknown command: /${parsed.name}\n\ntype /help to list available commands`,
    };
  }
  return { kind: 'local', output: await command.call(parsed.args, ctx) };
}

export function formatHelp(registry: CommandRegistry): string {
  const unique = Array.from(new Set(registry.values()));
  unique.sort((a, b) => a.name.localeCompare(b.name));
  const longest = Math.max(...unique.map((c) => c.name.length + aliasSuffix(c).length));
  const lines: string[] = [chalk.bold('slash commands'), ''];
  for (const command of unique) {
    const head = `/${command.name}${aliasSuffix(command)}`;
    const pad = ' '.repeat(Math.max(0, longest + 1 - head.length));
    lines.push(`  ${chalk.cyan(head)}${pad}  ${chalk.gray(command.description)}`);
    if (command.usage) {
      lines.push(`  ${' '.repeat(longest + 1)}  ${chalk.dim(command.usage)}`);
    }
  }
  lines.push('');
  lines.push(chalk.dim('hint: type / followed by a command name.'));
  return lines.join('\n');
}

function aliasSuffix(command: LocalCommand): string {
  const aliases = command.aliases ?? [];
  if (aliases.length === 0) return '';
  return ` (${aliases.join(', ')})`;
}

export const HELP_COMMAND: LocalCommand = {
  type: 'local',
  name: 'help',
  aliases: ['h', '?'],
  description: 'List available slash commands.',
  call: async (_args, ctx) => formatHelp(ctx.registry),
};
