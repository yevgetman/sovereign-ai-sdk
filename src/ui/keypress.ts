// Raw-mode keypress dispatcher. Replaces readline's line-oriented
// reads with a stream of typed Key events that the inputEditor and
// historySearch consume. Wave-4 foundation.
//
// We bypass node:readline.emitKeypressEvents() because its parser
// lacks bracketed-paste support and reports modifier state
// inconsistently across terminals. Instead we own the byte stream
// and produce a small, well-typed Key shape.
//
// Subscribers register a handler; each raw stdin chunk is parsed
// into 0+ Key events that fan out to every subscriber. The
// dispatcher is a process-wide singleton because there's only one
// stdin — but `enable()` / `disable()` is reference-counted so
// multiple subsystems (REPL editor, modal asker, picker) can ask
// for raw mode without stomping each other's state.

import { isModalActive } from './modal.js';

const ESC = '\x1b';

export type Key = {
  /** Symbolic name when recognised: 'enter', 'tab', 'backspace',
   *  'left', 'right', 'up', 'down', 'home', 'end', 'pageup',
   *  'pagedown', 'delete', 'escape'. Letter keys produce
   *  name === undefined; consult `sequence` instead. */
  name?: string;
  /** Single-char value for printable input. Empty for control / nav keys. */
  sequence: string;
  /** Raw bytes received — useful for unknown-sequence diagnostics. */
  raw: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** True when this key arrived inside a bracketed-paste burst.
   *  Subscribers can choose to treat paste content as a literal
   *  insert rather than running keybind handlers. */
  paste: boolean;
};

export type KeypressHandler = (key: Key) => void;

interface ReadableLike {
  setRawMode?(value: boolean): void;
  isTTY?: boolean;
  resume?(): void;
  pause?(): void;
  setEncoding?(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
}

interface WritableLike {
  write(chunk: string): boolean;
}

/** Process-wide singleton. The REPL constructs zero or one of these
 *  per session via getKeypressDispatcher(); subsystems that need
 *  raw-mode key events subscribe through the same handle. */
let singleton: KeypressDispatcher | undefined;

export function getKeypressDispatcher(): KeypressDispatcher {
  if (!singleton) singleton = new KeypressDispatcher(process.stdin, process.stdout);
  return singleton;
}

/** Test seam — replace the singleton with one bound to the given streams.
 *  Restores the previous singleton when the returned function is called. */
export function __setKeypressDispatcherForTests(
  input: ReadableLike,
  output: WritableLike,
): () => void {
  const previous = singleton;
  singleton = new KeypressDispatcher(input, output);
  return () => {
    singleton = previous;
  };
}

export class KeypressDispatcher {
  private input: ReadableLike;
  private output: WritableLike;
  private subscribers: Set<KeypressHandler> = new Set();
  private enableRefs = 0;
  private inPaste = false;
  private pendingPasteBuffer = '';
  private boundOnData: ((chunk: string | Buffer) => void) | null = null;

  constructor(input: ReadableLike = process.stdin, output: WritableLike = process.stdout) {
    this.input = input;
    this.output = output;
  }

  /** Activate raw mode + bracketed-paste and start dispatching keys
   *  to subscribers. Reference-counted: the Nth caller of enable()
   *  must be paired with N disable() calls before raw mode is
   *  released. */
  enable(): void {
    this.enableRefs++;
    if (this.enableRefs > 1) return;
    if (this.input.setRawMode && this.input.isTTY) {
      this.input.setRawMode(true);
    }
    this.input.setEncoding?.('utf8');
    this.input.resume?.();
    // Enable bracketed paste so multi-line pastes arrive in one
    // burst with paste=true on every Key; the editor inserts them
    // literally instead of running keybind handlers.
    this.output.write(`${ESC}[?2004h`);
    this.boundOnData = (chunk: string | Buffer) => this.onData(chunk);
    this.input.on('data', this.boundOnData);
  }

  disable(): void {
    if (this.enableRefs === 0) return;
    this.enableRefs--;
    if (this.enableRefs > 0) return;
    if (this.boundOnData) {
      this.input.off('data', this.boundOnData);
      this.boundOnData = null;
    }
    this.output.write(`${ESC}[?2004l`);
    if (this.input.setRawMode && this.input.isTTY) {
      this.input.setRawMode(false);
    }
    this.input.pause?.();
    // Reset paste-mode state so a subsequent enable() doesn't pick
    // up half-buffered paste content.
    this.inPaste = false;
    this.pendingPasteBuffer = '';
  }

  subscribe(handler: KeypressHandler): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** Parse a chunk and dispatch each key event. Exposed so tests
   *  can drive the dispatcher synchronously without managing a
   *  real stdin stream. */
  feed(chunk: string): void {
    this.onData(chunk);
  }

  private onData(chunk: string | Buffer): void {
    const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const keys = parseChunk(data, {
      inPaste: this.inPaste,
      pasteBuffer: this.pendingPasteBuffer,
    });
    this.inPaste = keys.inPaste;
    this.pendingPasteBuffer = keys.pasteBuffer;
    for (const key of keys.keys) this.dispatch(key);
  }

  private dispatch(key: Key): void {
    // While a modal is up, swallow keypresses so the editor doesn't
    // chew on input the modal needs. Modal owns its own readline-
    // based question() flow; this guard keeps ours from competing.
    if (isModalActive()) return;
    for (const handler of this.subscribers) handler(key);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Pure parsing — exported for tests
// ──────────────────────────────────────────────────────────────────────

type ParseState = { inPaste: boolean; pasteBuffer: string };
type ParseResult = { keys: Key[]; inPaste: boolean; pasteBuffer: string };

const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

export function parseChunk(input: string, state: ParseState): ParseResult {
  let buffer = state.pasteBuffer + input;
  let inPaste = state.inPaste;
  const keys: Key[] = [];

  while (buffer.length > 0) {
    if (inPaste) {
      const endIdx = buffer.indexOf(PASTE_END);
      if (endIdx === -1) {
        // Emit what we have so far as paste keys; the rest stays
        // in the buffer until the next chunk arrives.
        for (const ch of buffer) {
          keys.push(makePasteKey(ch));
        }
        return { keys, inPaste: true, pasteBuffer: '' };
      }
      const pasted = buffer.slice(0, endIdx);
      for (const ch of pasted) keys.push(makePasteKey(ch));
      buffer = buffer.slice(endIdx + PASTE_END.length);
      inPaste = false;
      continue;
    }

    if (buffer.startsWith(PASTE_START)) {
      buffer = buffer.slice(PASTE_START.length);
      inPaste = true;
      continue;
    }

    if (buffer.startsWith(ESC)) {
      const consumed = parseEscape(buffer);
      if (consumed.partial) {
        // Incomplete escape sequence — keep in buffer and wait for more.
        return { keys, inPaste, pasteBuffer: buffer };
      }
      keys.push(consumed.key);
      buffer = buffer.slice(consumed.consumed);
      continue;
    }

    // Non-escape: parse one character.
    const consumed = parseChar(buffer);
    keys.push(consumed.key);
    buffer = buffer.slice(consumed.consumed);
  }

  return { keys, inPaste, pasteBuffer: '' };
}

function makePasteKey(ch: string): Key {
  return {
    sequence: ch,
    raw: ch,
    ctrl: false,
    shift: false,
    alt: false,
    paste: true,
  };
}

type EscapeParse = { partial: true } | { partial: false; key: Key; consumed: number };

/** Parse an ESC-prefixed sequence. Returns partial=true when the
 *  buffer holds an incomplete escape that needs more bytes. */
function parseEscape(input: string): EscapeParse {
  // Bare ESC by itself is "escape" — but we need to wait at least
  // one tick to see if more bytes arrive (alt-key encoding sends
  // ESC + char). Treat a lone ESC at end of chunk as partial; the
  // next chunk completes it (or the dispatcher's flush logic will
  // emit it).
  if (input.length === 1) return { partial: true };

  // ESC + ASCII char (no [) → Alt + that char.
  if (input.length >= 2 && input[1] !== '[' && input[1] !== 'O') {
    return {
      partial: false,
      key: {
        sequence: input[1] ?? '',
        raw: input.slice(0, 2),
        ctrl: false,
        shift: false,
        alt: true,
        paste: false,
      },
      consumed: 2,
    };
  }

  // CSI sequence: ESC [ ... final-byte
  if (input[1] === '[') {
    // Find the final byte (in the range 0x40-0x7E).
    let i = 2;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) break;
      i++;
    }
    if (i >= input.length) return { partial: true };
    const seq = input.slice(0, i + 1);
    const key = mapCsiSequence(seq);
    return { partial: false, key, consumed: seq.length };
  }

  // SS3 sequence: ESC O ... (e.g. ESC O P for F1)
  if (input[1] === 'O') {
    if (input.length < 3) return { partial: true };
    const seq = input.slice(0, 3);
    const key = mapSs3Sequence(seq);
    return { partial: false, key, consumed: seq.length };
  }

  // Unknown — emit raw escape.
  return {
    partial: false,
    key: {
      name: 'escape',
      sequence: '',
      raw: ESC,
      ctrl: false,
      shift: false,
      alt: false,
      paste: false,
    },
    consumed: 1,
  };
}

function mapCsiSequence(seq: string): Key {
  // seq is `ESC[<params><final>`. Strip the ESC[ prefix.
  const body = seq.slice(2);
  const final = body[body.length - 1] ?? '';
  const params = body.slice(0, -1);

  // Modifier parsing for parameterized sequences like `1;5A` (Ctrl-Up).
  // params is something like '' or '5' or '1;5' or '5;3'.
  let modifiers = 0;
  if (params.includes(';')) {
    const parts = params.split(';');
    const last = parts[parts.length - 1];
    if (last) modifiers = Number.parseInt(last, 10) || 0;
  }
  const ctrl = ((modifiers - 1) & 0b100) !== 0;
  const shift = ((modifiers - 1) & 0b001) !== 0;
  const alt = ((modifiers - 1) & 0b010) !== 0;

  const baseKey: Omit<Key, 'name' | 'sequence'> = { raw: seq, ctrl, shift, alt, paste: false };

  // Final byte → name
  switch (final) {
    case 'A':
      return { ...baseKey, name: 'up', sequence: '' };
    case 'B':
      return { ...baseKey, name: 'down', sequence: '' };
    case 'C':
      return { ...baseKey, name: 'right', sequence: '' };
    case 'D':
      return { ...baseKey, name: 'left', sequence: '' };
    case 'H':
      return { ...baseKey, name: 'home', sequence: '' };
    case 'F':
      return { ...baseKey, name: 'end', sequence: '' };
    case 'Z':
      // Shift-Tab
      return { ...baseKey, name: 'tab', sequence: '', shift: true };
    case '~': {
      // ESC[<n>~ family — n maps to a named key.
      const num = Number.parseInt(params.split(';')[0] ?? '', 10);
      switch (num) {
        case 1:
        case 7:
          return { ...baseKey, name: 'home', sequence: '' };
        case 2:
          return { ...baseKey, name: 'insert', sequence: '' };
        case 3:
          return { ...baseKey, name: 'delete', sequence: '' };
        case 4:
        case 8:
          return { ...baseKey, name: 'end', sequence: '' };
        case 5:
          return { ...baseKey, name: 'pageup', sequence: '' };
        case 6:
          return { ...baseKey, name: 'pagedown', sequence: '' };
        default:
          return { ...baseKey, sequence: '' };
      }
    }
    default:
      return { ...baseKey, sequence: '' };
  }
}

function mapSs3Sequence(seq: string): Key {
  const final = seq[2] ?? '';
  const base: Omit<Key, 'name' | 'sequence'> = {
    raw: seq,
    ctrl: false,
    shift: false,
    alt: false,
    paste: false,
  };
  switch (final) {
    case 'A':
      return { ...base, name: 'up', sequence: '' };
    case 'B':
      return { ...base, name: 'down', sequence: '' };
    case 'C':
      return { ...base, name: 'right', sequence: '' };
    case 'D':
      return { ...base, name: 'left', sequence: '' };
    case 'H':
      return { ...base, name: 'home', sequence: '' };
    case 'F':
      return { ...base, name: 'end', sequence: '' };
    default:
      return { ...base, sequence: '' };
  }
}

function parseChar(input: string): { key: Key; consumed: number } {
  const ch = input[0] ?? '';
  const code = ch.charCodeAt(0);

  // Control chars (Ctrl+letter). 0x01='ctrl-a' (code+0x60), 0x1f='ctrl-_'.
  if (code === 0x00) {
    return { key: makeCtrl(' ', '\x00'), consumed: 1 };
  }
  if (code === 0x09) {
    return {
      key: {
        name: 'tab',
        sequence: '',
        raw: ch,
        ctrl: false,
        shift: false,
        alt: false,
        paste: false,
      },
      consumed: 1,
    };
  }
  if (code === 0x0a || code === 0x0d) {
    return {
      key: {
        name: 'enter',
        sequence: '',
        raw: ch,
        ctrl: false,
        shift: false,
        alt: false,
        paste: false,
      },
      consumed: 1,
    };
  }
  if (code === 0x7f || code === 0x08) {
    return {
      key: {
        name: 'backspace',
        sequence: '',
        raw: ch,
        ctrl: false,
        shift: false,
        alt: false,
        paste: false,
      },
      consumed: 1,
    };
  }
  if (code >= 0x01 && code <= 0x1a) {
    // Ctrl + letter (a..z). Decode to lowercase ASCII letter.
    const letter = String.fromCharCode(code + 0x60);
    return { key: makeCtrl(letter, ch), consumed: 1 };
  }
  if (code === 0x1c || code === 0x1d || code === 0x1e || code === 0x1f) {
    // Ctrl + \, ], ^, _ — unusual but valid. Pass through.
    const map: Record<number, string> = { 28: '\\', 29: ']', 30: '^', 31: '_' };
    return { key: makeCtrl(map[code] ?? '', ch), consumed: 1 };
  }

  // Printable / multi-byte UTF-8: emit one Key per JS code unit. The
  // editor inserts via TextBuffer which handles grapheme width.
  return {
    key: { sequence: ch, raw: ch, ctrl: false, shift: false, alt: false, paste: false },
    consumed: 1,
  };
}

function makeCtrl(letter: string, raw: string): Key {
  const name = ctrlName(letter);
  return {
    sequence: letter,
    raw,
    ctrl: true,
    shift: false,
    alt: false,
    paste: false,
    ...(name !== undefined ? { name } : {}),
  };
}

function ctrlName(letter: string): string | undefined {
  // Common Ctrl-letter mappings most users expect to see by symbolic
  // name in keybind tables. Letters not listed here just have
  // ctrl=true and sequence='<letter>'.
  const named: Record<string, string> = {
    a: 'ctrl-a',
    b: 'ctrl-b',
    c: 'ctrl-c',
    d: 'ctrl-d',
    e: 'ctrl-e',
    f: 'ctrl-f',
    h: 'backspace', // ^H
    k: 'ctrl-k',
    l: 'ctrl-l',
    n: 'ctrl-n',
    p: 'ctrl-p',
    r: 'ctrl-r',
    u: 'ctrl-u',
    w: 'ctrl-w',
    z: 'ctrl-z',
  };
  return named[letter];
}
