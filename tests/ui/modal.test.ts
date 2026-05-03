// withModal: rendering, parsing, re-prompt loop, modal-active flag,
// nested-modal guard. The frame itself is exercised via renderFrame
// which lets tests assert on exact body content without waiting on
// readline. The full withModal flow is exercised against a stub
// question() that returns scripted answers.

import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { isModalActive, renderFrame, withModal } from '../../src/ui/modal.js';

chalk.level = 1;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

class StringSink {
  out = '';
  write(chunk: string): boolean {
    this.out += chunk;
    return true;
  }
}

function scriptedQuestion(answers: string[]): (prompt: string) => Promise<string> {
  let i = 0;
  return async (_prompt: string) => {
    const a = answers[i++];
    if (a === undefined) throw new Error('scriptedQuestion: out of answers');
    return a;
  };
}

describe('renderFrame', () => {
  test('renders title, rows, and choices inside a box', () => {
    const lines = renderFrame(
      'permission required',
      [
        { label: 'tool', value: 'Bash' },
        { label: 'reason', value: 'needs approval' },
      ],
      [
        { key: 'y', label: 'allow' },
        { key: 'n', label: 'deny', default: true },
      ],
      chalk.yellow,
    );
    const text = lines.map(strip).join('\n');
    expect(text).toContain('permission required');
    expect(text).toContain('tool');
    expect(text).toContain('Bash');
    expect(text).toContain('reason');
    expect(text).toContain('needs approval');
    expect(text).toContain('[y]');
    expect(text).toContain('[N]'); // default → uppercase
    // bordered top + bottom
    expect(text.split('\n')[0]).toMatch(/^╭/);
    expect(text.split('\n').at(-1)).toMatch(/^╰/);
  });

  test('rows and choices are optional', () => {
    const lines = renderFrame('title only', [], [], chalk.gray);
    const text = lines.map(strip).join('\n');
    expect(text).toContain('title only');
    expect(text).not.toContain('[');
  });
});

describe('withModal', () => {
  test('renders frame, parses answer, returns parsed value', async () => {
    const sink = new StringSink();
    const result = await withModal({
      title: 'permission required',
      rows: [{ label: 'tool', value: 'Bash' }],
      choices: [{ key: 'y', label: 'allow' }],
      parse: (raw) => (raw.trim() === 'y' ? 'allow' : undefined),
      question: scriptedQuestion(['y']),
      out: sink,
    });
    expect(result).toBe('allow');
    expect(strip(sink.out)).toContain('permission required');
    expect(strip(sink.out)).toContain('Bash');
    expect(isModalActive()).toBe(false);
  });

  test('re-prompts on parse failure with the configured message', async () => {
    const sink = new StringSink();
    const result = await withModal({
      title: 't',
      rows: [],
      choices: [],
      parse: (raw) => (raw === 'ok' ? 'ok' : undefined),
      question: scriptedQuestion(['??', 'ok']),
      out: sink,
      reprompt: 'try ok',
    });
    expect(result).toBe('ok');
    expect(strip(sink.out)).toContain('try ok');
  });

  test('isModalActive() is true while running, false after', async () => {
    const sink = new StringSink();
    const states: boolean[] = [];
    const question = async () => {
      states.push(isModalActive());
      return 'y';
    };
    expect(isModalActive()).toBe(false);
    await withModal({
      title: 't',
      rows: [],
      choices: [],
      parse: () => 'allow',
      question,
      out: sink,
    });
    expect(states).toEqual([true]);
    expect(isModalActive()).toBe(false);
  });

  test('clears modal-active flag even if the parser throws', async () => {
    const sink = new StringSink();
    const failingQuestion = async () => {
      throw new Error('boom');
    };
    await expect(
      withModal({
        title: 't',
        rows: [],
        choices: [],
        parse: () => 'x',
        question: failingQuestion,
        out: sink,
      }),
    ).rejects.toThrow('boom');
    expect(isModalActive()).toBe(false);
  });

  test('refuses to nest modals', async () => {
    const sink = new StringSink();
    let nestedRejection: unknown;
    const result = await withModal({
      title: 'outer',
      rows: [],
      choices: [],
      parse: () => 'x',
      // While outer is active (its question is running), a nested
      // withModal should throw immediately rather than racing the
      // outer's flag.
      question: async () => {
        try {
          await withModal({
            title: 'nested',
            rows: [],
            choices: [],
            parse: () => 'y',
            question: scriptedQuestion(['y']),
            out: sink,
          });
        } catch (err) {
          nestedRejection = err;
        }
        return 'x';
      },
      out: sink,
    });
    expect(result).toBe('x');
    expect(nestedRejection).toBeInstanceOf(Error);
    expect((nestedRejection as Error).message).toContain('a modal is already active');
    expect(isModalActive()).toBe(false);
  });
});
