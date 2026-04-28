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
});
