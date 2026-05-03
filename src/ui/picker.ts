// Reusable raw-mode picker. Generalizes the pattern already proven in
// `src/ui/configMenu.ts`: take over the screen, hide the cursor, switch
// stdin to raw mode, render an item list with one selected row, dispatch
// ↑/↓/PgUp/PgDn/Home/End, return the selected value on Enter or null
// on Esc/Ctrl-C.
//
// Wave 2 ships the navigation primitive only; type-to-filter and
// fuzzy search are explicit Wave 4 work that lands alongside the
// input editor (so we own all keypress handling cohesively rather
// than splitting the logic).
//
// Slash commands invoke this between turns when the REPL has handed
// us control. The picker fully restores raw-mode / cursor / screen
// state in its `finally` block so a thrown error can't leave the
// terminal in a bad state.

import chalk from 'chalk';

const ESC = '\x1b';
const KEY = {
  UP: `${ESC}[A`,
  DOWN: `${ESC}[B`,
  PAGE_UP: `${ESC}[5~`,
  PAGE_DOWN: `${ESC}[6~`,
  HOME: `${ESC}[H`,
  END: `${ESC}[F`,
  ENTER: '\r',
  CTRL_C: '\x03',
  ESC: '\x1b',
} as const;

export type PickerItem<T> = {
  /** Primary line, what the user sees and matches against. */
  label: string;
  /** Optional secondary line shown only on the highlighted row. */
  hint?: string;
  /** The value returned when this item is chosen. */
  value: T;
  /** Disabled rows render dim and Enter is a no-op on them. */
  disabled?: boolean;
};

export type PickerOpts<T> = {
  title: string;
  items: PickerItem<T>[];
  /** Initial selection index (clamped). Default: first non-disabled row. */
  initial?: number;
  /** Optional second-line under the title (e.g. "showing 12 sessions"). */
  subtitle?: string;
  /** Custom footer shown under the list. Defaults to the standard hint. */
  footerHint?: string;
  /** Page size for PgUp/PgDn. Default 10. */
  pageSize?: number;
};

/**
 * Render a full-screen picker, return the chosen value on Enter or
 * null on Esc / Ctrl-C / closed input. Returns null immediately if
 * `items` is empty or stdin isn't a TTY (caller should fall back to
 * a text-mode prompt or print a list).
 */
export async function pick<T>(opts: PickerOpts<T>): Promise<T | null> {
  if (!process.stdin.isTTY) return null;
  if (opts.items.length === 0) return null;

  const items = opts.items;
  const pageSize = opts.pageSize ?? 10;
  const firstSelectable = findFirstSelectable(items);
  if (firstSelectable === -1) return null;
  let selected = clamp(opts.initial ?? firstSelectable, 0, items.length - 1);
  if (items[selected]?.disabled) selected = firstSelectable;

  hideCursor();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

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

  try {
    while (true) {
      render(opts, items, selected);
      const key = await readKey();
      if (key === KEY.ESC || key === KEY.CTRL_C) return null;
      if (key === KEY.ENTER) {
        const item = items[selected];
        if (!item || item.disabled) continue;
        return item.value;
      }
      if (key === KEY.UP) {
        selected = stepSelection(items, selected, -1);
        continue;
      }
      if (key === KEY.DOWN) {
        selected = stepSelection(items, selected, 1);
        continue;
      }
      if (key === KEY.PAGE_UP) {
        selected = stepSelection(items, selected, -pageSize);
        continue;
      }
      if (key === KEY.PAGE_DOWN) {
        selected = stepSelection(items, selected, pageSize);
        continue;
      }
      if (key === KEY.HOME) {
        selected = findFirstSelectable(items);
        continue;
      }
      if (key === KEY.END) {
        selected = findLastSelectable(items);
      }
      // Unknown key — ignore and re-render. (Type-to-filter is Wave 4.)
    }
  } finally {
    process.off('SIGINT', onSigint);
    cleanup();
    clearScreen();
  }
}

function render<T>(opts: PickerOpts<T>, items: PickerItem<T>[], selected: number): void {
  clearScreen();
  const lines: string[] = [];
  lines.push(chalk.bold(opts.title));
  if (opts.subtitle) lines.push(chalk.gray(opts.subtitle));
  lines.push('');

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const cursor = i === selected ? chalk.cyan('›') : ' ';
    const label = item.disabled
      ? chalk.dim(item.label)
      : i === selected
        ? chalk.bold(item.label)
        : item.label;
    lines.push(`${cursor} ${label}`);
    if (i === selected && item.hint) {
      lines.push(`  ${chalk.gray(item.hint)}`);
    }
  }
  lines.push('');
  lines.push(chalk.gray(opts.footerHint ?? '↑/↓ navigate · enter confirm · esc cancel'));
  process.stdout.write(`${lines.join('\n')}\n`);
}

function stepSelection<T>(items: PickerItem<T>[], current: number, delta: number): number {
  if (items.length === 0) return current;
  let next = current;
  const step = delta === 0 ? 0 : delta > 0 ? 1 : -1;
  const total = Math.abs(delta);
  for (let attempts = 0; attempts < total; attempts++) {
    let candidate = next;
    for (let i = 0; i < items.length; i++) {
      candidate = (candidate + step + items.length) % items.length;
      if (!items[candidate]?.disabled) {
        next = candidate;
        break;
      }
    }
  }
  return next;
}

function findFirstSelectable<T>(items: PickerItem<T>[]): number {
  for (let i = 0; i < items.length; i++) {
    if (!items[i]?.disabled) return i;
  }
  return -1;
}

function findLastSelectable<T>(items: PickerItem<T>[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!items[i]?.disabled) return i;
  }
  return -1;
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clearScreen(): void {
  process.stdout.write(`${ESC}[2J${ESC}[H`);
}
function hideCursor(): void {
  process.stdout.write(`${ESC}[?25l`);
}
function showCursor(): void {
  process.stdout.write(`${ESC}[?25h`);
}

async function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      process.stdin.off('data', onData);
      resolve(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    };
    process.stdin.on('data', onData);
  });
}

/** Test seam: navigation logic exposed pure for tests. The full picker
 *  loop is integration-tested via slash command behavior. */
export const __test__ = { stepSelection, findFirstSelectable, findLastSelectable };
