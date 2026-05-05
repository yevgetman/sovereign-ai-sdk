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

function renderCard(info: SplashInfo, maxWidth: number): string[] {
  const t = theme.tokens;
  const title = `${t.accent('>_')} ${t.textBold('Sovereign AI')} ${t.textMuted(`(v${PKG_VERSION})`)}`;
  const auth = `${info.providerLabel} ${t.textMuted('|')} ${info.authLabel}`;
  const model = `${info.model} ${t.textMuted('(/model to change)')}`;
  const bundle = t.textMuted(
    info.bundlePath ? abbreviatePath(info.bundlePath, maxWidth) : 'no bundle',
  );
  return [title, auth, model, bundle];
}

/** Shorten a long bundle path by collapsing leading segments to "…/".
 *  Keeps the last 1–2 path segments intact (the meaningful part to a
 *  user). Returns the path unchanged when it already fits. */
function abbreviatePath(path: string, maxWidth: number): string {
  if (path.length <= maxWidth) return path;
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return path;
  // Try keeping more and more trailing segments; pick the longest tail
  // that fits with the "…/" prefix.
  for (let keep = Math.min(segments.length, 3); keep >= 1; keep--) {
    const tail = segments.slice(-keep).join('/');
    const candidate = `…/${tail}`;
    if (candidate.length <= maxWidth) return candidate;
  }
  // Even one segment is too long — hard-truncate.
  const last = segments[segments.length - 1] ?? path;
  return `…/${last.slice(0, Math.max(1, maxWidth - 2))}`;
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

/** Minimum spare-room margin between the splash content and the
 *  terminal's right edge. Without it the box-drawing characters can
 *  visually crowd the edge even when they don't strictly wrap. */
const SAFETY_MARGIN = 2;
/** Gap between the logo and the card in side-by-side layout. */
const GUTTER = 2;
/** Minimum card-content width that still looks reasonable. Below
 *  this, side-by-side isn't even attempted; we stack instead. */
const MIN_CARD_BUDGET = 30;

export function renderSplash(info: SplashInfo, terminalCols?: number): string {
  const cols = terminalCols ?? process.stdout.columns ?? 80;
  const logoWidth = LOGO_LINES[0]?.length ?? 0;
  const t = theme.tokens;

  // Layout selection — measure first, decide second.
  //
  // The original heuristic ("side-by-side if budget for the card-content
  // line is >= 30") let the layout sneak through at terminal widths
  // where the rendered row was right at the edge. A font whose box-
  // drawing characters are even slightly wider than one cell (a common
  // condition with fallback fonts on box-drawing glyphs) then pushed
  // the row past the right edge and the terminal wrapped each logo row
  // mid-glyph, fragmenting the ASCII art into apparent garbage.
  //
  // Now: build the card at the side-by-side budget, then ask whether
  // logo + gutter + actual cardWidth + safety margin fits inside cols.
  // If not, fall through to stacked. This is correct by construction
  // rather than threshold-by-trial.
  const sideBySideBudget = cols - logoWidth - SAFETY_MARGIN - 2 /* gutter */ - 4 /* card padding */;
  const stackedBudget = cols - SAFETY_MARGIN - 4 /* card padding */;
  // Build the side-by-side candidate first to measure its real width.
  const sideBySideCard =
    sideBySideBudget >= MIN_CARD_BUDGET
      ? boxify(renderCard(info, sideBySideBudget), { padding: 2 })
      : null;
  const sideBySideCardWidth = sideBySideCard ? Math.max(...sideBySideCard.map(visibleWidth)) : 0;
  const sideBySideRowWidth = logoWidth + GUTTER + sideBySideCardWidth;
  // Use side-by-side only when the row fits comfortably. SAFETY_MARGIN
  // protects against terminals that render box-drawing chars wider
  // than one cell — without it we get the regression where the row
  // visually overflows even though the cell math says it fits.
  const useStacked = sideBySideCard === null || sideBySideRowWidth + SAFETY_MARGIN > cols;

  const cardLines = useStacked
    ? boxify(renderCard(info, stackedBudget), { padding: 2 })
    : (sideBySideCard ?? boxify(renderCard(info, stackedBudget), { padding: 2 }));
  const cardWidth = Math.max(...cardLines.map(visibleWidth));

  const tips = t.textMuted(
    'Tips: type / for slash commands · @file:path to inline files · /quit to exit',
  );
  const modeNote = info.permissionModeNote ?? '';
  const footer = t.textDim(
    `perms: ${info.permissionMode}${modeNote} · tools: ${info.toolCount} · cache: ${info.cacheOn ? 'on' : 'off'} · ${info.sessionLabel} · ${info.exitHint}`,
  );

  if (useStacked) {
    // Narrow terminal: stack the logo above the card vertically. Drop
    // the logo entirely when it's wider than the terminal — the box-
    // drawing characters fragment when wrapped.
    const coloredLogo =
      logoWidth + SAFETY_MARGIN <= cols
        ? LOGO_LINES.map((line, i) => (LOGO_GRADIENT[i] ?? chalk.cyan)(line))
        : [];
    return [
      '',
      ...coloredLogo,
      ...(coloredLogo.length > 0 ? [''] : []),
      ...cardLines,
      '',
      tips,
      footer,
      '',
    ].join('\n');
  }

  // Side-by-side layout: logo on the left, card on the right.
  const coloredLogo = LOGO_LINES.map((line, i) => {
    const tint = LOGO_GRADIENT[i] ?? chalk.cyan;
    return tint(line);
  });
  const height = Math.max(coloredLogo.length, cardLines.length);
  const left = padBlock(coloredLogo, height, logoWidth);
  // Vertically center the card against the logo.
  const cardOffset = Math.max(0, Math.floor((height - cardLines.length) / 2));
  const right: string[] = Array(height).fill('');
  for (let i = 0; i < cardLines.length; i++) {
    right[cardOffset + i] = cardLines[i] ?? '';
  }
  const rows = left.map((l, i) => `${l}  ${padRight(right[i] ?? '', cardWidth)}`);
  return ['', ...rows, '', tips, footer, ''].join('\n');
}
