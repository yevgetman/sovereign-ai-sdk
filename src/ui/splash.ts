// Splash banner shown at REPL startup. Renders a block-letter "S" mark
// (a nod to the Sovereign AI logo) next to a small info card with
// version, provider/auth, model, and bundle path. Below it: a tips line
// and a one-line dim footer with the operational details that the old
// multi-line banner carried (permissions, tools, cache, session).

import chalk from 'chalk';

const PKG_VERSION = '0.0.1';

const LOGO_LINES = [
  '  ███████╗ ',
  '  ██╔════╝ ',
  '  ███████╗ ',
  '  ╚════██║ ',
  '  ███████║ ',
  '  ╚══════╝ ',
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
  bundlePath: string;
  permissionMode: string;
  permissionModeNote?: string;
  toolCount: number;
  cacheOn: boolean;
  sessionLabel: string;
  exitHint: string;
};

function renderCard(info: SplashInfo): string[] {
  const title = `${chalk.cyan('>_')} ${chalk.bold('Sovereign AI')} ${chalk.gray(`(v${PKG_VERSION})`)}`;
  const auth = `${info.providerLabel} ${chalk.gray('|')} ${info.authLabel}`;
  const model = `${info.model} ${chalk.gray('(/model to change)')}`;
  const bundle = chalk.gray(info.bundlePath);
  return [title, auth, model, bundle];
}

function padBlock(lines: string[], targetHeight: number, width: number): string[] {
  const pad = ' '.repeat(width);
  const out = [...lines];
  while (out.length < targetHeight) out.push(pad);
  return out;
}

export function renderSplash(info: SplashInfo): string {
  const logoWidth = LOGO_LINES[0]?.length ?? 0;
  const coloredLogo = LOGO_LINES.map((line, i) => {
    const tint = LOGO_GRADIENT[i] ?? chalk.cyan;
    return tint(line);
  });
  const card = renderCard(info);
  const height = Math.max(coloredLogo.length, card.length);
  const left = padBlock(coloredLogo, height, logoWidth);
  // Vertically center the card against the logo.
  const cardOffset = Math.max(0, Math.floor((height - card.length) / 2));
  const right: string[] = Array(height).fill('');
  for (let i = 0; i < card.length; i++) {
    right[cardOffset + i] = card[i] ?? '';
  }
  const rows = left.map((l, i) => `${l}  ${right[i] ?? ''}`);
  const tips = chalk.gray(
    'Tips: type / for slash commands · @file:path to inline files · /quit to exit',
  );
  const modeNote = info.permissionModeNote ?? '';
  const footer = chalk.dim(
    `perms: ${info.permissionMode}${modeNote} · tools: ${info.toolCount} · cache: ${info.cacheOn ? 'on' : 'off'} · ${info.sessionLabel} · ${info.exitHint}`,
  );
  return ['', ...rows, '', tips, footer, ''].join('\n');
}
