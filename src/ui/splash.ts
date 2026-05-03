// Splash banner shown at REPL startup. Renders a block-letter "SOV" mark
// (a nod to the Sovereign AI logo, shortened to match the `sov` binary)
// next to a small info card with version, provider/auth, model, and
// bundle path. Below it: a tips line and a one-line dim footer with
// the operational details that the old multi-line banner carried
// (permissions, tools, cache, session).

import chalk from 'chalk';
import { boxify, visibleWidth } from './box.js';
import { theme } from './theme.js';

const PKG_VERSION = '0.0.1';

// "ANSI Shadow" figlet font — same letterforms throughout. Each row is
// the same width; the renderer pads short lines via padBlock.
const LOGO_LINES = [
  '  ███████╗ ██████╗ ██╗   ██╗ ',
  '  ██╔════╝██╔═══██╗██║   ██║ ',
  '  ███████╗██║   ██║██║   ██║ ',
  '  ╚════██║██║   ██║╚██╗ ██╔╝ ',
  '  ███████║╚██████╔╝ ╚████╔╝  ',
  '  ╚══════╝ ╚═════╝   ╚═══╝   ',
];

// Cyan→blue gradient that visually echoes the logo's lightning-slash
// shading. One color per logo row, top to bottom.
const LOGO_GRADIENT = [
  chalk.cyanBright,
  chalk.cyan,
  chalk.blueBright,
  chalk.blue,
  chalk.blue,
  chalk.blueBright,
];

export type SplashInfo = {
  providerLabel: string;
  authLabel: string;
  model: string;
  /** Bundle path, or null in generic-agent mode. */
  bundlePath: string | null;
  permissionMode: string;
  permissionModeNote?: string;
  toolCount: number;
  cacheOn: boolean;
  sessionLabel: string;
  exitHint: string;
};

function renderCard(info: SplashInfo): string[] {
  const t = theme.tokens;
  const title = `${t.accent('>_')} ${t.textBold('Sovereign AI')} ${t.textMuted(`(v${PKG_VERSION})`)}`;
  const auth = `${info.providerLabel} ${t.textMuted('|')} ${info.authLabel}`;
  const model = `${info.model} ${t.textMuted('(/model to change)')}`;
  const bundle = t.textMuted(info.bundlePath ?? 'no bundle');
  return [title, auth, model, bundle];
}

function padBlock(lines: string[], targetHeight: number, width: number): string[] {
  const pad = ' '.repeat(width);
  const out = [...lines];
  while (out.length < targetHeight) out.push(pad);
  return out;
}

function padRight(line: string, width: number): string {
  const fill = Math.max(0, width - visibleWidth(line));
  return `${line}${' '.repeat(fill)}`;
}

export function renderSplash(info: SplashInfo): string {
  const logoWidth = LOGO_LINES[0]?.length ?? 0;
  const coloredLogo = LOGO_LINES.map((line, i) => {
    const tint = LOGO_GRADIENT[i] ?? chalk.cyan;
    return tint(line);
  });
  const cardLines = boxify(renderCard(info), { padding: 2 });
  const cardWidth = Math.max(...cardLines.map(visibleWidth));
  const height = Math.max(coloredLogo.length, cardLines.length);
  const left = padBlock(coloredLogo, height, logoWidth);
  // Vertically center the card against the logo.
  const cardOffset = Math.max(0, Math.floor((height - cardLines.length) / 2));
  const right: string[] = Array(height).fill('');
  for (let i = 0; i < cardLines.length; i++) {
    right[cardOffset + i] = cardLines[i] ?? '';
  }
  const rows = left.map((l, i) => `${l}  ${padRight(right[i] ?? '', cardWidth)}`);
  const t = theme.tokens;
  const tips = t.textMuted(
    'Tips: type / for slash commands · @file:path to inline files · /quit to exit',
  );
  const modeNote = info.permissionModeNote ?? '';
  const footer = t.textDim(
    `perms: ${info.permissionMode}${modeNote} · tools: ${info.toolCount} · cache: ${info.cacheOn ? 'on' : 'off'} · ${info.sessionLabel} · ${info.exitHint}`,
  );
  return ['', ...rows, '', tips, footer, ''].join('\n');
}
