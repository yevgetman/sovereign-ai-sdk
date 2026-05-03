// Integration tests for inputEditor. Drives the editor with a fake
// keypress dispatcher and a fake out stream — no real stdin / stdout.
// Verifies submit semantics, multi-line continuation, history nav,
// keybind dispatch.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputEditor } from '../../src/ui/inputEditor.js';
import { InputHistory } from '../../src/ui/inputHistory.js';
import type { Key, KeypressDispatcher, KeypressHandler } from '../../src/ui/keypress.js';

class FakeDispatcher {
  private handlers: KeypressHandler[] = [];
  enabled = 0;
  enable(): void {
    this.enabled++;
  }
  disable(): void {
    this.enabled--;
  }
  subscribe(handler: KeypressHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  feed(key: Key): void {
    for (const h of this.handlers) h(key);
  }
}

class StringSink {
  out = '';
  write(chunk: string): boolean {
    this.out += chunk;
    return true;
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sov-editor-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEditor(commands: string[] = []): {
  editor: InputEditor;
  dispatcher: FakeDispatcher;
  out: StringSink;
  history: InputHistory;
} {
  const dispatcher = new FakeDispatcher();
  const out = new StringSink();
  const history = new InputHistory({ path: join(dir, 'history') });
  history.load();
  const editor = new InputEditor({
    keypress: dispatcher as unknown as KeypressDispatcher,
    history,
    out,
    commandNames: () => commands,
    cwd: () => dir,
  });
  return { editor, dispatcher, out, history };
}

function key(name: string, opts: Partial<Key> = {}): Key {
  return {
    name,
    sequence: opts.sequence ?? '',
    raw: opts.raw ?? '',
    ctrl: opts.ctrl ?? false,
    shift: opts.shift ?? false,
    alt: opts.alt ?? false,
    paste: opts.paste ?? false,
  };
}

function char(c: string, opts: Partial<Key> = {}): Key {
  return {
    sequence: c,
    raw: c,
    ctrl: opts.ctrl ?? false,
    shift: opts.shift ?? false,
    alt: opts.alt ?? false,
    paste: opts.paste ?? false,
  };
}

describe('InputEditor.ask', () => {
  test('Enter submits the typed text', async () => {
    const { editor, dispatcher } = makeEditor();
    const promise = editor.ask('> ');
    dispatcher.feed(char('h'));
    dispatcher.feed(char('i'));
    dispatcher.feed(key('enter'));
    await expect(promise).resolves.toBe('hi');
  });

  test('empty Enter resolves with empty string', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('');
  });

  test('trailing backslash + Enter inserts newline rather than submitting', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    for (const c of 'foo\\') dispatcher.feed(char(c));
    dispatcher.feed(key('enter'));
    for (const c of 'bar') dispatcher.feed(char(c));
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('foo\nbar');
  });

  test('Backspace deletes left', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    for (const c of 'foox') dispatcher.feed(char(c));
    dispatcher.feed(key('backspace'));
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('foo');
  });

  test('Ctrl-C on empty buffer rejects with EOF', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    dispatcher.feed(key('ctrl-c', { ctrl: true, sequence: 'c' }));
    await expect(p).rejects.toMatchObject({ name: 'EOF' });
  });

  test('Ctrl-C on non-empty buffer clears it; second exits', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    for (const c of 'hello') dispatcher.feed(char(c));
    dispatcher.feed(key('ctrl-c', { ctrl: true, sequence: 'c' }));
    expect(editor.__testValue()).toBe('');
    dispatcher.feed(key('ctrl-c', { ctrl: true, sequence: 'c' }));
    await expect(p).rejects.toMatchObject({ name: 'EOF' });
  });

  test('Ctrl-D on empty buffer rejects with EOF', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    dispatcher.feed(key('ctrl-d', { ctrl: true, sequence: 'd' }));
    await expect(p).rejects.toMatchObject({ name: 'EOF' });
  });

  test('paste keys insert literally without keybind dispatch', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    // A Ctrl-C inside a paste burst should NOT trigger clear.
    dispatcher.feed({
      sequence: 'a',
      raw: 'a',
      ctrl: false,
      shift: false,
      alt: false,
      paste: true,
    });
    dispatcher.feed({
      sequence: '\n',
      raw: '\n',
      ctrl: false,
      shift: false,
      alt: false,
      paste: true,
    });
    dispatcher.feed({
      sequence: 'b',
      raw: 'b',
      ctrl: false,
      shift: false,
      alt: false,
      paste: true,
    });
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('a\nb');
  });
});

describe('InputEditor — history', () => {
  test('Up walks back through history; Down walks forward', async () => {
    const { editor, dispatcher, history } = makeEditor();
    history.add('one');
    history.add('two');
    history.add('three');
    const p = editor.ask('> ');
    dispatcher.feed(key('up'));
    expect(editor.__testValue()).toBe('three');
    dispatcher.feed(key('up'));
    expect(editor.__testValue()).toBe('two');
    dispatcher.feed(key('up'));
    expect(editor.__testValue()).toBe('one');
    dispatcher.feed(key('up'));
    // No more entries — stays on 'one'
    expect(editor.__testValue()).toBe('one');
    dispatcher.feed(key('down'));
    expect(editor.__testValue()).toBe('two');
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('two');
  });

  test('typing first, then Up restores draft on Down past most-recent', async () => {
    const { editor, dispatcher, history } = makeEditor();
    history.add('alpha');
    const p = editor.ask('> ');
    for (const c of 'draft') dispatcher.feed(char(c));
    dispatcher.feed(key('up'));
    expect(editor.__testValue()).toBe('alpha');
    dispatcher.feed(key('down'));
    expect(editor.__testValue()).toBe('draft');
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('draft');
  });

  test('submitted input is added to history', async () => {
    const { editor, dispatcher, history } = makeEditor();
    const p = editor.ask('> ');
    for (const c of 'fresh') dispatcher.feed(char(c));
    dispatcher.feed(key('enter'));
    await p;
    expect(history.snapshot()).toEqual(['fresh']);
  });
});

describe('InputEditor — Ctrl-A / E / U / K / W', () => {
  test('Ctrl-A then Ctrl-K leaves the buffer empty', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    for (const c of 'hello') dispatcher.feed(char(c));
    dispatcher.feed(key('ctrl-a', { ctrl: true, sequence: 'a' }));
    dispatcher.feed(key('ctrl-k', { ctrl: true, sequence: 'k' }));
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('');
  });

  test('Ctrl-W deletes the previous word', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    for (const c of 'one two three') dispatcher.feed(char(c));
    dispatcher.feed(key('ctrl-w', { ctrl: true, sequence: 'w' }));
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('one two ');
  });

  test('Ctrl-U deletes from line start to cursor', async () => {
    const { editor, dispatcher } = makeEditor();
    const p = editor.ask('> ');
    for (const c of 'hello world') dispatcher.feed(char(c));
    dispatcher.feed(key('ctrl-u', { ctrl: true, sequence: 'u' }));
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('');
  });
});

describe('InputEditor — autocomplete', () => {
  test('Tab on /he completes to /help', async () => {
    const { editor, dispatcher } = makeEditor(['help', 'cost']);
    const p = editor.ask('> ');
    dispatcher.feed(char('/'));
    dispatcher.feed(char('h'));
    dispatcher.feed(char('e'));
    dispatcher.feed(key('tab'));
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('/help');
  });

  test('Tab on /c cycles between matches', async () => {
    const { editor, dispatcher } = makeEditor(['cost', 'commit', 'compact']);
    const p = editor.ask('> ');
    dispatcher.feed(char('/'));
    dispatcher.feed(char('c'));
    dispatcher.feed(key('tab'));
    expect(editor.__testValue()).toBe('/commit');
    dispatcher.feed(key('tab'));
    expect(editor.__testValue()).toBe('/compact');
    dispatcher.feed(key('tab'));
    expect(editor.__testValue()).toBe('/cost');
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('/cost');
  });

  test('Tab with no matches is a no-op', async () => {
    const { editor, dispatcher } = makeEditor(['help']);
    const p = editor.ask('> ');
    dispatcher.feed(char('/'));
    dispatcher.feed(char('z'));
    dispatcher.feed(key('tab'));
    expect(editor.__testValue()).toBe('/z');
    dispatcher.feed(key('enter'));
    await expect(p).resolves.toBe('/z');
  });
});
