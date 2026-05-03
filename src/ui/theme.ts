// Semantic theme system. Renderers consume tokens by role (`accent`,
// `statusSuccess`, `diffAdded`) instead of named colors (`chalk.cyan`,
// `chalk.green`, `chalk.red`). Switching themes mutates a singleton
// — every subsequent render call picks up the new tokens.
//
// Wave 3 ships three themes: dark (default — preserves the existing
// look exactly), light (tuned for light backgrounds), and no-color
// (returns input unchanged for CI / pipes / NO_COLOR=1). Custom
// themes loaded from `~/.harness/themes/<name>.json` are explicit
// Wave 4+ work; the singleton is structured to absorb them without
// API churn.
//
// Chalk respects the NO_COLOR environment variable automatically, so
// the dark/light themes also degrade to plain text under NO_COLOR
// even though they nominally apply colors. The no-color theme is
// useful when the user wants plain output without setting NO_COLOR
// globally (e.g. capturing transcripts with no ANSI).

import chalk from 'chalk';

/** A token applies styling to a string and returns the styled result.
 *  Plain identity for the no-color theme, chalk-bound functions for
 *  the colored themes. */
export type Token = (text: string) => string;

/** All semantic roles a renderer might need. Adding a token here is
 *  a cross-cutting change: every theme must specify it, every test
 *  exercising the token registry references it. Don't add speculative
 *  tokens — wait until a renderer actually needs one. */
export type ThemeTokens = {
  // Text roles
  text: Token;
  textMuted: Token;
  textDim: Token;
  textBold: Token;
  textItalic: Token;
  // Accent (primary brand color)
  accent: Token;
  accentBold: Token;
  accentMuted: Token;
  // Status
  statusSuccess: Token;
  statusWarning: Token;
  statusError: Token;
  statusInfo: Token;
  // Diff blocks
  diffAdded: Token;
  diffRemoved: Token;
  diffContext: Token;
  // Borders
  border: Token;
  borderAccent: Token;
  borderWarning: Token;
  // Code rendering
  codeInline: Token;
  codeFence: Token;
  // Markdown headers
  headerH1: Token;
  headerH2: Token;
  headerH3: Token;
};

export type Theme = {
  name: string;
  description: string;
  tokens: ThemeTokens;
};

const identity: Token = (s) => s;

/** Compose two tokens left-to-right: outer(inner(text)). Lets themes
 *  build token like `chalk.bold.yellow` without sacrificing the
 *  swap-a-color-only pattern. */
function compose(outer: Token, inner: Token): Token {
  return (text) => outer(inner(text));
}

const darkTheme: Theme = {
  name: 'dark',
  description: 'Default — cyan accents on a dark terminal background.',
  tokens: {
    text: identity,
    textMuted: chalk.gray,
    textDim: chalk.dim,
    textBold: chalk.bold,
    textItalic: chalk.italic,
    accent: chalk.cyan,
    accentBold: compose(chalk.bold, chalk.cyan),
    accentMuted: chalk.blue,
    statusSuccess: chalk.green,
    statusWarning: chalk.yellow,
    statusError: chalk.red,
    statusInfo: chalk.cyan,
    diffAdded: chalk.green,
    diffRemoved: chalk.red,
    diffContext: chalk.gray,
    border: chalk.gray,
    borderAccent: chalk.cyan,
    borderWarning: chalk.yellow,
    codeInline: chalk.yellow,
    codeFence: chalk.gray,
    headerH1: compose(chalk.bold, chalk.underline),
    headerH2: chalk.bold,
    headerH3: compose(chalk.bold, chalk.gray),
  },
};

// Light theme: same role assignments, but darker primaries so cyan
// doesn't disappear into a white background. Yellow becomes orange-ish
// via rgb() so it has enough contrast.
const lightTheme: Theme = {
  name: 'light',
  description: 'Light theme — darker primaries for light terminals.',
  tokens: {
    text: identity,
    textMuted: chalk.gray,
    textDim: chalk.dim,
    textBold: chalk.bold,
    textItalic: chalk.italic,
    accent: chalk.blue,
    accentBold: compose(chalk.bold, chalk.blue),
    accentMuted: chalk.magenta,
    statusSuccess: chalk.green,
    statusWarning: chalk.rgb(180, 90, 0),
    statusError: chalk.red,
    statusInfo: chalk.blue,
    diffAdded: chalk.green,
    diffRemoved: chalk.red,
    diffContext: chalk.gray,
    border: chalk.gray,
    borderAccent: chalk.blue,
    borderWarning: chalk.rgb(180, 90, 0),
    codeInline: chalk.rgb(150, 100, 0),
    codeFence: chalk.gray,
    headerH1: compose(chalk.bold, chalk.underline),
    headerH2: chalk.bold,
    headerH3: compose(chalk.bold, chalk.gray),
  },
};

const noColorTheme: Theme = {
  name: 'no-color',
  description: 'Plain text — no ANSI styling, useful for transcripts and pipes.',
  tokens: {
    text: identity,
    textMuted: identity,
    textDim: identity,
    textBold: identity,
    textItalic: identity,
    accent: identity,
    accentBold: identity,
    accentMuted: identity,
    statusSuccess: identity,
    statusWarning: identity,
    statusError: identity,
    statusInfo: identity,
    diffAdded: identity,
    diffRemoved: identity,
    diffContext: identity,
    border: identity,
    borderAccent: identity,
    borderWarning: identity,
    codeInline: identity,
    codeFence: identity,
    headerH1: identity,
    headerH2: identity,
    headerH3: identity,
  },
};

const REGISTRY: Map<string, Theme> = new Map([
  ['dark', darkTheme],
  ['light', lightTheme],
  ['no-color', noColorTheme],
]);

/** Active theme — module singleton. Default 'dark' so existing
 *  renderers and tests get the same output as before this module
 *  landed. Mutated by setTheme; read by getTheme / theme.tokens. */
let active: Theme = darkTheme;

export function getTheme(): Theme {
  return active;
}

export function setTheme(name: string): Theme {
  const theme = REGISTRY.get(name);
  if (!theme) {
    const known = listThemes()
      .map((t) => t.name)
      .join(', ');
    throw new Error(`unknown theme: ${name} (known: ${known})`);
  }
  active = theme;
  return theme;
}

export function listThemes(): Theme[] {
  return Array.from(REGISTRY.values());
}

export function isThemeName(name: string): boolean {
  return REGISTRY.has(name);
}

/** Resolve a setting to a real theme name. Honors NO_COLOR and the
 *  caller-provided name, falling back to 'dark'. Used at REPL startup
 *  before any rendering happens. */
export function resolveThemeName(opts: {
  configured?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = opts.env ?? process.env;
  if (env.NO_COLOR && env.NO_COLOR.length > 0) return 'no-color';
  if (opts.configured && isThemeName(opts.configured)) return opts.configured;
  return 'dark';
}

/** Convenience handle for renderers — `theme.tokens.accent('hi')`. The
 *  proxy delegates to `active` so swapping themes via setTheme() takes
 *  effect on the next call without renderers having to subscribe. */
export const theme = {
  get tokens(): ThemeTokens {
    return active.tokens;
  },
  get name(): string {
    return active.name;
  },
};

/** Test seam — explicit reset between cases. Restores the default
 *  dark theme so a test that called setTheme doesn't leak state. */
export function __resetForTests(): void {
  active = darkTheme;
}
