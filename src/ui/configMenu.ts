// Hand-rolled raw-mode config picker for `sovereign config` (no verb).
// Single-screen list of common keys with ↑/↓ navigation, Enter to edit,
// `u` to unset, q/Esc to quit. Each commit re-validates through the
// SettingsSchema; rejected changes are shown inline.
//
// Phase 10.1 interim — Phase 16.7 (TUI polish with Ink) is expected to
// supersede this with a richer Ink-based component. Keep the
// dependency surface zero so that swap is clean.

import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import type { Settings } from '../config/schema.js';
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

type Field = {
  path: string;
  label: string;
  hint?: string;
  secret?: boolean;
  /** When set, Enter shows a small choice picker; the last entry is
   *  always "type custom value..." which falls through to readline.
   *  May be a function so choices can depend on other settings (e.g.
   *  defaultModel scoped by defaultProvider). */
  choices?: string[] | ((settings: Settings) => string[]);
};

const CUSTOM_SENTINEL = '↪ type custom value…';

const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'],
  ollama: ['qwen2.5:7b', 'qwen2.5:3b', 'qwen2.5:14b', 'llama3.1:8b'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  openrouter: ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5'],
};

const FIELDS: Field[] = [
  {
    path: 'defaultProvider',
    label: 'defaultProvider',
    choices: ['anthropic', 'ollama', 'openai', 'openrouter'],
  },
  {
    path: 'defaultModel',
    label: 'defaultModel',
    hint: 'scoped by defaultProvider',
    choices: (settings) => PROVIDER_MODELS[settings.defaultProvider ?? 'anthropic'] ?? [],
  },
  {
    path: 'permissionMode',
    label: 'permissionMode',
    choices: ['default', 'ask', 'bypass'],
  },
  {
    path: 'providers.anthropic.model',
    label: 'providers.anthropic.model',
    choices: PROVIDER_MODELS.anthropic,
  },
  { path: 'providers.anthropic.apiKey', label: 'providers.anthropic.apiKey', secret: true },
  {
    path: 'providers.openai.model',
    label: 'providers.openai.model',
    choices: PROVIDER_MODELS.openai,
  },
  { path: 'providers.openai.baseUrl', label: 'providers.openai.baseUrl' },
  { path: 'providers.openai.apiKey', label: 'providers.openai.apiKey', secret: true },
  {
    path: 'providers.openrouter.model',
    label: 'providers.openrouter.model',
    choices: PROVIDER_MODELS.openrouter,
  },
  { path: 'providers.openrouter.apiKey', label: 'providers.openrouter.apiKey', secret: true },
  {
    path: 'providers.ollama.model',
    label: 'providers.ollama.model',
    choices: PROVIDER_MODELS.ollama,
  },
  {
    path: 'providers.ollama.baseUrl',
    label: 'providers.ollama.baseUrl',
    hint: 'http://localhost:11434',
  },
  {
    path: 'providers.ollama.numCtx',
    label: 'providers.ollama.numCtx',
    hint: 'override num_ctx (default: model context length)',
  },
  { path: 'microcompaction.enabled', label: 'microcompaction.enabled', hint: 'true | false' },
  { path: 'microcompaction.keepRecent', label: 'microcompaction.keepRecent', hint: 'integer' },
  {
    path: 'microcompaction.triggerThresholdPct',
    label: 'microcompaction.triggerThresholdPct',
    hint: '0–100',
  },
];

const ESC = '\x1b';
const KEY = {
  UP: `${ESC}[A`,
  DOWN: `${ESC}[B`,
  ENTER: '\r',
  CTRL_C: '\x03',
  ESC: '\x1b',
};

function clearScreen(): void {
  process.stdout.write(`${ESC}[2J${ESC}[H`);
}

function hideCursor(): void {
  process.stdout.write(`${ESC}[?25l`);
}

function showCursor(): void {
  process.stdout.write(`${ESC}[?25h`);
}

type ViewState = {
  selected: number;
  status: string;
  statusKind: 'info' | 'error' | 'ok';
};

function render(state: ViewState): void {
  clearScreen();
  const settings = readConfig();
  const redacted = redactSecrets(settings);
  const labelWidth = Math.max(...FIELDS.map((f) => f.label.length));
  const lines: string[] = [];
  lines.push(chalk.bold('config') + chalk.gray(`  ${resolveConfigPath()}`));
  lines.push('');
  for (let i = 0; i < FIELDS.length; i++) {
    const field = FIELDS[i];
    if (!field) continue;
    const cursor = i === state.selected ? chalk.cyan('›') : ' ';
    const label = i === state.selected ? chalk.bold(field.label) : field.label;
    const padding = ' '.repeat(labelWidth - field.label.length);
    const rawValue = getAt(redacted, field.path);
    const valueStr = rawValue === undefined ? chalk.gray('(unset)') : formatValue(rawValue);
    const hint = field.hint && i === state.selected ? chalk.gray(`  — ${field.hint}`) : '';
    lines.push(`${cursor} ${label}${padding}  ${valueStr}${hint}`);
  }
  lines.push('');
  if (state.status) {
    const tinted =
      state.statusKind === 'error'
        ? chalk.red(state.status)
        : state.statusKind === 'ok'
          ? chalk.green(state.status)
          : chalk.gray(state.status);
    lines.push(tinted);
  } else {
    lines.push('');
  }
  const footer = chalk.gray('↑/↓ navigate · enter edit · u unset · q quit and save');
  process.stdout.write(`${lines.join('\n')}\n${footer}\n`);
}

async function promptValue(field: Field, currentRaw: unknown): Promise<string | null> {
  // Drop raw mode and use a normal readline prompt for the input line.
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  showCursor();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('\n');
    const display = field.secret
      ? '(hidden)'
      : currentRaw === undefined
        ? '(unset)'
        : formatValue(currentRaw);
    process.stdout.write(chalk.gray(`current: ${display}\n`));
    const answer = await rl.question(chalk.cyan(`new value for ${field.label} (esc to cancel): `));
    if (answer.length === 0) return null;
    return answer;
  } finally {
    rl.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    hideCursor();
  }
}

function resolveChoices(field: Field, settings: Settings): string[] {
  if (!field.choices) return [];
  return typeof field.choices === 'function' ? field.choices(settings) : field.choices;
}

async function pickFromChoices(
  field: Field,
  currentRaw: unknown,
  settings: Settings,
): Promise<string | null | typeof CUSTOM_SENTINEL> {
  const choices = resolveChoices(field, settings);
  const all = [...choices, CUSTOM_SENTINEL];
  const currentStr = typeof currentRaw === 'string' ? currentRaw : '';
  let selected = Math.max(0, all.indexOf(currentStr));
  while (true) {
    process.stdout.write(`${ESC}[2J${ESC}[H`);
    const lines: string[] = [];
    lines.push(chalk.bold(field.label));
    if (currentStr) lines.push(chalk.gray(`current: ${currentStr}`));
    lines.push('');
    for (let i = 0; i < all.length; i++) {
      const cursor = i === selected ? chalk.cyan('›') : ' ';
      const value = all[i] ?? '';
      const text =
        i === selected
          ? chalk.bold(value === CUSTOM_SENTINEL ? chalk.gray(value) : value)
          : value === CUSTOM_SENTINEL
            ? chalk.gray(value)
            : value;
      lines.push(`${cursor} ${text}`);
    }
    lines.push('');
    lines.push(chalk.gray('↑/↓ select · enter confirm · esc cancel'));
    process.stdout.write(`${lines.join('\n')}\n`);
    const key = await readKey();
    if (key === KEY.ESC || key === KEY.CTRL_C) return null;
    if (key === KEY.UP) {
      selected = (selected - 1 + all.length) % all.length;
      continue;
    }
    if (key === KEY.DOWN) {
      selected = (selected + 1) % all.length;
      continue;
    }
    if (key === KEY.ENTER) {
      const choice = all[selected] ?? '';
      return choice === CUSTOM_SENTINEL ? CUSTOM_SENTINEL : choice;
    }
  }
}

async function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.off('data', onData);
      resolve(chunk.toString('utf8'));
    };
    process.stdin.on('data', onData);
  });
}

export async function runConfigMenu(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'sovereign config (interactive mode) requires a TTY. Use sovereign config <verb> for scripting.',
    );
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  hideCursor();

  const cleanup = (): void => {
    showCursor();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };
  const onSigint = (): void => {
    cleanup();
    process.stdout.write('\n');
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  const state: ViewState = { selected: 0, status: '', statusKind: 'info' };
  try {
    let running = true;
    while (running) {
      render(state);
      const key = await readKey();
      state.status = '';
      if (key === KEY.CTRL_C || key === 'q' || key === KEY.ESC) {
        running = false;
        break;
      }
      if (key === KEY.UP) {
        state.selected = (state.selected - 1 + FIELDS.length) % FIELDS.length;
        continue;
      }
      if (key === KEY.DOWN) {
        state.selected = (state.selected + 1) % FIELDS.length;
        continue;
      }
      const field = FIELDS[state.selected];
      if (!field) continue;
      if (key === 'u' || key === 'U') {
        try {
          writeConfig(unsetAt(readConfig(), field.path));
          state.status = `unset ${field.path}`;
          state.statusKind = 'ok';
        } catch (err) {
          state.status = err instanceof Error ? err.message : String(err);
          state.statusKind = 'error';
        }
        continue;
      }
      if (key === KEY.ENTER) {
        const current = readConfig();
        const raw = field.secret ? undefined : getAt(current, field.path);
        let chosen: string | null = null;
        const choices = resolveChoices(field, current);
        if (choices.length > 0) {
          const picked = await pickFromChoices(field, raw, current);
          if (picked === null) {
            state.status = 'cancelled';
            state.statusKind = 'info';
            continue;
          }
          if (picked === CUSTOM_SENTINEL) {
            chosen = await promptValue(field, raw);
          } else {
            chosen = picked;
          }
        } else {
          chosen = await promptValue(field, raw);
        }
        if (chosen === null) {
          state.status = 'cancelled';
          state.statusKind = 'info';
          continue;
        }
        try {
          const value = parseValueLiteral(chosen);
          writeConfig(setAt(current, field.path, value));
          state.status = `set ${field.path}`;
          state.statusKind = 'ok';
        } catch (err) {
          state.status = err instanceof Error ? err.message : String(err);
          state.statusKind = 'error';
        }
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    cleanup();
    process.stdout.write(chalk.gray('\nconfig closed.\n'));
  }
}

export const __test__ = { FIELDS };
