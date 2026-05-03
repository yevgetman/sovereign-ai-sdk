// Session-shaping slash commands: /export and /init.
//
// /export writes the in-memory message history to a file in the cwd
// in one of three formats — markdown (human-readable), jsonl (one
// message per line, easy to grep/diff/replay), or json (pretty-
// printed full transcript). Picker chooses the format when no arg is
// given; passing the format inline (`/export md`) skips the picker.
//
// /init asks the model to scan the project and write a CONTEXT.md
// briefing. Implemented as a prompt-command so it flows through the
// normal turn loop and inherits the regular permission gates for the
// FileWrite that lands the briefing.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type { ContentBlock, Message } from '../core/types.js';
import { type PickerItem, pick } from '../ui/picker.js';
import type { CommandContext, LocalCommand, PromptCommand } from './types.js';

export type ExportFormat = 'md' | 'jsonl' | 'json';

const EXPORT_FORMATS: { format: ExportFormat; ext: string; label: string; hint: string }[] = [
  { format: 'md', ext: 'md', label: 'markdown', hint: 'Human-readable, one section per turn' },
  {
    format: 'jsonl',
    ext: 'jsonl',
    label: 'jsonl',
    hint: 'One message per line — easy to grep/diff/replay',
  },
  {
    format: 'json',
    ext: 'json',
    label: 'json',
    hint: 'Pretty-printed full transcript with content blocks',
  },
];

export const exportCommand: LocalCommand = {
  type: 'local',
  name: 'export',
  description: 'Export the current session transcript (md / jsonl / json).',
  usage: '/export [md|jsonl|json]',
  call: async (args, ctx) => runExport(args, ctx),
};

export const initCommand: PromptCommand = {
  type: 'prompt',
  name: 'init',
  description: 'Scan the project and write a CONTEXT.md briefing.',
  allowedTools: [
    'Glob',
    'FileRead',
    'FileWrite',
    'Bash(ls *)',
    'Bash(git status)',
    'Bash(git log -*)',
  ],
  getPromptForCommand: async (args, ctx) => {
    const targetArg = args.trim();
    const target = targetArg.length > 0 ? targetArg : './CONTEXT.md';
    return [
      {
        type: 'text',
        text: [
          `Initialize this project's harness context.`,
          '',
          `Scan the project at ${ctx.cwd} using Glob and FileRead. Read package.json (or equivalent), README, top-level config files, and one or two representative source files to build a fast mental model. Avoid full reads of generated/build/lock files.`,
          '',
          `Then write a concise ${target} covering:`,
          '',
          '1. **Project**: what this codebase is, in 1–2 sentences',
          '2. **Entry points**: the files / commands an agent should know about',
          '3. **Build / test / run**: the commands a developer or agent will use',
          '4. **Conventions**: anything notable about coding style, layout, dependencies',
          '5. **Things to avoid**: gotchas, anti-patterns, or paths the agent should not edit',
          '',
          `Keep ${target} under 200 lines. Don't speculate — only include facts evident from the files. If the file already exists, propose changes inline before overwriting.`,
        ].join('\n'),
      },
    ];
  },
};

export const SESSION_OPS_COMMANDS = [exportCommand, initCommand] as const;

// ──────────────────────────────────────────────────────────────────────
// /export
// ──────────────────────────────────────────────────────────────────────

async function runExport(args: string, ctx: CommandContext): Promise<string> {
  const messages = ctx.getMessages();
  if (messages.length === 0) {
    return 'no messages in this session yet — nothing to export.';
  }

  const explicit = args.trim().toLowerCase();
  let format: ExportFormat | null = null;
  if (explicit) {
    if (explicit === 'md' || explicit === 'jsonl' || explicit === 'json') {
      format = explicit;
    } else {
      return `unknown format: ${explicit}\nusage: /export [md|jsonl|json]`;
    }
  }

  if (format === null) {
    if (!process.stdin.isTTY) {
      return 'export needs a format on non-TTY: /export md, /export jsonl, or /export json.';
    }
    const items: PickerItem<ExportFormat>[] = EXPORT_FORMATS.map((f) => ({
      label: f.label,
      hint: f.hint,
      value: f.format,
    }));
    const chosen = await pick<ExportFormat>({
      title: 'export session',
      subtitle: `${messages.length} message${messages.length === 1 ? '' : 's'}`,
      items,
    });
    if (chosen === null) return 'export cancelled.';
    format = chosen;
  }

  const ext = EXPORT_FORMATS.find((f) => f.format === format)?.ext ?? format;
  const filename = `session-${ctx.sessionId.slice(0, 8)}.${ext}`;
  const fullPath = join(ctx.cwd, filename);
  const body = renderExport(messages, format, ctx);

  try {
    writeFileSync(fullPath, body, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return chalk.red(`export failed: ${msg}`);
  }
  return [
    `exported ${messages.length} message${messages.length === 1 ? '' : 's'} as ${format}`,
    `  → ${fullPath}`,
  ].join('\n');
}

export function renderExport(
  messages: Message[],
  format: ExportFormat,
  ctx: CommandContext,
): string {
  if (format === 'jsonl') return renderJsonl(messages);
  if (format === 'json') return renderJson(messages, ctx);
  return renderMarkdown(messages, ctx);
}

function renderMarkdown(messages: Message[], ctx: CommandContext): string {
  const lines: string[] = [];
  lines.push(`# Session ${ctx.sessionId}`);
  lines.push('');
  lines.push(`- **provider**: ${ctx.providerName}`);
  lines.push(`- **model**: ${ctx.model}`);
  lines.push(`- **bundle**: ${ctx.bundlePath ?? 'no bundle'}`);
  lines.push(`- **messages**: ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  let turnIndex = 0;
  for (const msg of messages) {
    if (msg.role === 'user') turnIndex++;
    const heading = msg.role === 'user' ? `## Turn ${turnIndex} — User` : '### Assistant';
    lines.push(heading);
    lines.push('');
    for (const block of msg.content) {
      lines.push(...formatBlockMarkdown(block));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function formatBlockMarkdown(block: ContentBlock): string[] {
  if (block.type === 'text') {
    return [block.text, ''];
  }
  if (block.type === 'thinking') {
    return ['<details><summary>thinking</summary>', '', block.thinking, '', '</details>', ''];
  }
  if (block.type === 'tool_use') {
    const inputJson = JSON.stringify(block.input, null, 2);
    return [`**→ tool: \`${block.name}\`**`, '', '```json', inputJson, '```', ''];
  }
  if (block.type === 'tool_result') {
    const errMark = block.is_error ? ' (error)' : '';
    return [`**← result${errMark}**`, '', '```', block.content, '```', ''];
  }
  if (block.type === 'image') {
    return [`*image: ${block.source.media_type} (base64 omitted)*`, ''];
  }
  return [];
}

function renderJsonl(messages: Message[]): string {
  return `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`;
}

function renderJson(messages: Message[], ctx: CommandContext): string {
  return `${JSON.stringify(
    {
      sessionId: ctx.sessionId,
      providerName: ctx.providerName,
      model: ctx.model,
      bundlePath: ctx.bundlePath,
      messages,
    },
    null,
    2,
  )}\n`;
}
