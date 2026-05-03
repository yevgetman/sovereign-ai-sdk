// Queued readline prompt tests for pasted multi-line input.

import { describe, expect, test } from 'bun:test';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { createQueuedQuestion } from '../../src/ui/queuedQuestion.js';

function makeQuestion() {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompts: string[] = [];
  const rl = createInterface({ input, output, terminal: false });
  const question = createQueuedQuestion(rl, (prompt) => {
    prompts.push(prompt);
  });
  return { input, prompts, question, close: () => rl.close() };
}

describe('createQueuedQuestion', () => {
  test('preserves extra pasted lines for later prompts', async () => {
    const { input, prompts, question, close } = makeQuestion();
    try {
      const first = question('you> ');
      input.write('/cost\n/quit\n');

      await expect(first).resolves.toBe('/cost');
      await expect(question('you> ')).resolves.toBe('/quit');
      expect(prompts).toEqual(['you> ', 'you> ']);
    } finally {
      close();
    }
  });

  test('rejects a pending prompt when readline closes', async () => {
    const { question, close } = makeQuestion();
    const pending = question('you> ');

    close();

    await expect(pending).rejects.toThrow('readline closed');
  });

  test('drains queued lines even after readline has closed', async () => {
    // This is the piped-stdin pattern: every line arrives in one burst,
    // EOF fires almost immediately, the REPL hasn't yet called
    // question() for the second line. The queue must hand it out anyway.
    const { input, question, close } = makeQuestion();
    input.write('/copy\n/export md\n/quit\n');
    // Tiny delay so the readline 'line' events flush before close fires.
    await new Promise((resolve) => setTimeout(resolve, 5));
    close();
    await expect(question('> ')).resolves.toBe('/copy');
    await expect(question('> ')).resolves.toBe('/export md');
    await expect(question('> ')).resolves.toBe('/quit');
    await expect(question('> ')).rejects.toThrow('readline closed');
  });
});
