// Picker-driven slash commands: /resume, /model. Both take over the
// terminal (raw mode, full-screen render) for the duration of the
// pick, then return a short text summary that the REPL prints in
// the normal flow.
//
// /resume currently doesn't do an in-process session swap — that's
// gated on Wave 4's input editor where we control more of the
// cursor model. For Wave 2, /resume picks a session and prints
// the resume command for the user to run on next launch. The pain
// point it solves ("must remember the UUID to use --resume") is
// fixed even without in-process loading.
//
// /model uses the same provider→model mapping that configMenu.ts
// uses. Both are kept in sync via a tiny shared registry.

import { readConfig, resolveConfigPath, setAt, writeConfig } from '../config/store.js';
import { type PickerItem, pick } from '../ui/picker.js';
import { type Theme, isThemeName, listThemes, setTheme, theme } from '../ui/theme.js';
import type { CommandContext, LocalCommand } from './types.js';

/** Provider → models registry. Mirrors configMenu.ts's PROVIDER_MODELS
 *  but exported so /model and the config picker stay in sync. */
const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'],
  ollama: ['qwen2.5:7b', 'qwen2.5:3b', 'qwen2.5:14b', 'llama3.1:8b'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  openrouter: ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5'],
};

export const resumeCommand: LocalCommand = {
  type: 'local',
  name: 'resume',
  description: 'Pick a recent session by title and print its resume command.',
  call: async (_args, ctx) => runResumePicker(ctx),
};

export const modelPickerCommand: LocalCommand = {
  type: 'local',
  name: 'model',
  description: 'Switch the active model — opens a picker, or accepts a name as arg.',
  usage: '/model [<name>]',
  call: async (args, ctx) => runModelPicker(args, ctx),
};

export const themePickerCommand: LocalCommand = {
  type: 'local',
  name: 'theme',
  description: 'Switch the color theme — opens a picker, or accepts a name as arg.',
  usage: '/theme [<name>]',
  call: async (args, _ctx) => runThemePicker(args),
};

export const PICKER_COMMANDS: LocalCommand[] = [
  resumeCommand,
  modelPickerCommand,
  themePickerCommand,
];

// ──────────────────────────────────────────────────────────────────────
// /resume
// ──────────────────────────────────────────────────────────────────────

async function runResumePicker(ctx: CommandContext): Promise<string> {
  if (!process.stdin.isTTY) {
    return 'resume picker requires a TTY. Use `sov --resume <uuid>` from the shell.';
  }
  const sessions = ctx.listSessions(20);
  if (sessions.length === 0) {
    return 'no recorded sessions yet — start chatting to build the resume list.';
  }

  const items: PickerItem<string>[] = sessions.map((s) => {
    const titleText = s.title ?? '(no title)';
    const ago = formatRelativeTime(s.lastUpdated);
    const cost = s.totalCostUsd > 0 ? formatUsd(s.totalCostUsd) : '$0.00';
    const meta = `${ago} · ${s.msgCount} msg · ${s.provider}/${s.model} · ${cost}`;
    return {
      label: truncate(titleText, 70),
      hint: meta,
      value: s.sessionId,
    };
  });

  const sessionId = await pick<string>({
    title: 'resume session',
    subtitle: `${sessions.length} most-recent session${sessions.length === 1 ? '' : 's'}`,
    items,
    initial: 0,
  });
  if (sessionId === null) return 'resume cancelled.';

  const chosen = sessions.find((s) => s.sessionId === sessionId);
  if (!chosen) return `selection error: session ${sessionId} not found.`;

  // For Wave 2, /resume prints the command rather than swapping in-
  // process. The user can /quit and run it. (The frequent flow — pick
  // a recent session and resume — works in the same pair of keystrokes
  // either way; in-process swap is an explicit Wave-4 deliverable.)
  const cmd =
    chosen.parentSessionId !== null
      ? `sov --resume ${chosen.sessionId}`
      : `sov --resume ${chosen.sessionId}`;
  const lines = [
    `selected session ${chosen.sessionId.slice(0, 8)}`,
    `  title:    ${chosen.title ?? '(no title)'}`,
    `  model:    ${chosen.provider}/${chosen.model}`,
    `  messages: ${chosen.msgCount}`,
    '',
    'to resume in a fresh REPL:',
    `  ${cmd}`,
    '',
    '(in-process resume is Wave 4 work; for now /quit and run the command above.)',
  ];
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// /model
// ──────────────────────────────────────────────────────────────────────

async function runModelPicker(args: string, ctx: CommandContext): Promise<string> {
  const explicit = args.trim();
  if (explicit) {
    ctx.setModel(explicit);
    return `model set to ${explicit} (persisted to session ${ctx.sessionId.slice(0, 8)}).`;
  }
  if (!process.stdin.isTTY) {
    return `current model: ${ctx.model}\n(model picker requires a TTY; run \`/model <name>\` to set non-interactively.)`;
  }
  const models = PROVIDER_MODELS[ctx.providerName] ?? [];
  if (models.length === 0) {
    return `current model: ${ctx.model}\nno preset models registered for provider \`${ctx.providerName}\`. Run \`/model <name>\` to set explicitly, or edit ${resolveConfigPath()}.`;
  }

  const items: PickerItem<string>[] = models.map((name) => ({
    label: name,
    value: name,
    ...(name === ctx.model ? { hint: '(current)' } : {}),
  }));
  const initial = Math.max(
    0,
    models.findIndex((m) => m === ctx.model),
  );
  const chosen = await pick<string>({
    title: 'switch model',
    subtitle: `provider: ${ctx.providerName}`,
    items,
    initial,
  });
  if (chosen === null) return `model unchanged (current: ${ctx.model}).`;
  if (chosen === ctx.model) return `model unchanged (already on ${ctx.model}).`;
  ctx.setModel(chosen);
  return `model set to ${chosen} (persisted to session ${ctx.sessionId.slice(0, 8)}).`;
}

// ──────────────────────────────────────────────────────────────────────
// /theme
// ──────────────────────────────────────────────────────────────────────

async function runThemePicker(args: string): Promise<string> {
  const themes = listThemes();
  const explicit = args.trim();
  if (explicit) {
    if (!isThemeName(explicit)) {
      const names = themes.map((t) => t.name).join(', ');
      return `unknown theme: ${explicit}\nknown: ${names}`;
    }
    return applyAndPersistTheme(explicit);
  }
  if (!process.stdin.isTTY) {
    const lines: string[] = [];
    lines.push(`current theme: ${theme.name}`);
    lines.push('');
    lines.push('available:');
    for (const t of themes)
      lines.push(`  ${t.name}  ${theme.tokens.textMuted(`— ${t.description}`)}`);
    lines.push('');
    lines.push('(theme picker requires a TTY; run `/theme <name>` to set non-interactively.)');
    return lines.join('\n');
  }
  const items: PickerItem<string>[] = themes.map((t) => ({
    label: t.name,
    hint: t.description,
    value: t.name,
    ...(t.name === theme.name ? { hint: `${t.description}  (current)` } : {}),
  }));
  const initial = Math.max(
    0,
    themes.findIndex((t) => t.name === theme.name),
  );
  const chosen = await pick<string>({
    title: 'switch theme',
    subtitle: 'changes apply immediately and persist to ~/.harness/config.json',
    items,
    initial,
  });
  if (chosen === null) return `theme unchanged (current: ${theme.name}).`;
  if (chosen === theme.name) return `theme unchanged (already on ${chosen}).`;
  return applyAndPersistTheme(chosen);
}

function applyAndPersistTheme(name: string): string {
  const t = setTheme(name);
  try {
    writeConfig(setAt(readConfig(), 'ui.theme', name));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `theme set to ${name} (in-process); persisting failed: ${msg}`;
  }
  return [
    `theme set to ${theme.tokens.accent(name)} ${theme.tokens.textMuted(`(${t.description})`)}`,
    renderThemeSwatch(t),
    `persisted to ${resolveConfigPath()}`,
  ].join('\n');
}

function renderThemeSwatch(t: Theme): string {
  const tk = t.tokens;
  return [
    `  ${tk.accent('accent')}  ${tk.statusSuccess('success')}  ${tk.statusWarning('warning')}  ${tk.statusError('error')}  ${tk.textMuted('muted')}  ${tk.textDim('dim')}`,
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatRelativeTime(epochSeconds: number): string {
  const nowSec = Date.now() / 1000;
  const ageSec = Math.max(0, nowSec - epochSeconds);
  if (ageSec < 60) return `${Math.round(ageSec)}s ago`;
  const ageMin = ageSec / 60;
  if (ageMin < 60) return `${Math.round(ageMin)}m ago`;
  const ageHr = ageMin / 60;
  if (ageHr < 24) return `${Math.round(ageHr)}h ago`;
  const ageDay = ageHr / 24;
  if (ageDay < 30) return `${Math.round(ageDay)}d ago`;
  const ageMon = ageDay / 30;
  if (ageMon < 12) return `${Math.round(ageMon)}mo ago`;
  return `${Math.round(ageMon / 12)}y ago`;
}

function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Test seam — exposes the relative-time helper without spinning up a picker. */
export const __test__ = { formatRelativeTime, PROVIDER_MODELS };
