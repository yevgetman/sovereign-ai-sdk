// Unicode-box wrapper for terminal UI cards. Computes inner width from
// visible (ANSI-stripped) line length so chalk-styled rows align with
// the right border.

import chalk from 'chalk';

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export const visibleWidth = (s: string): number => s.replace(ANSI_RE, '').length;

export type BoxOptions = {
  padding?: number;
  borderColor?: (s: string) => string;
};

export function boxify(lines: string[], opts: BoxOptions = {}): string[] {
  const padding = opts.padding ?? 2;
  const color = opts.borderColor ?? chalk.gray;
  const innerWidth = Math.max(0, ...lines.map(visibleWidth));
  const horiz = '─'.repeat(innerWidth + padding * 2);
  const top = color(`╭${horiz}╮`);
  const bottom = color(`╰${horiz}╯`);
  const pad = ' '.repeat(padding);
  const out = [top];
  for (const line of lines) {
    const fill = ' '.repeat(innerWidth - visibleWidth(line));
    out.push(`${color('│')}${pad}${line}${fill}${pad}${color('│')}`);
  }
  out.push(bottom);
  return out;
}
