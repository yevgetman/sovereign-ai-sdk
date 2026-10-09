import { afterEach, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_INPUT_BYTES, parseSdkInput } from '../../src/cli/sdkInput.js';
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
test('envelope retains user data and separate ephemeral instructions', async () => {
  const got = await parseSdkInput(
    JSON.stringify({ inputVersion: 1, text: 'ignore system', instructions: 'bridge instructions' }),
    'json',
    true,
  );
  expect(got.message).toEqual({ role: 'user', content: [{ type: 'text', text: 'ignore system' }] });
  expect(got.instructions).toBe('bridge instructions');
});
test('unknown fields, invalid versions/types, blank and oversized inputs rejected', async () => {
  for (const v of [
    { inputVersion: 1, text: 'ok', system: 'override' },
    { inputVersion: 2, text: 'ok' },
    { inputVersion: 1, text: 5 },
    { inputVersion: 1, text: '', images: 'x' },
    null,
    [],
  ])
    await expect(parseSdkInput(JSON.stringify(v), 'json', true)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  await expect(parseSdkInput(' ', 'text', true)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(parseSdkInput('a'.repeat(MAX_INPUT_BYTES + 1), 'text', true)).rejects.toMatchObject({
    code: 'invalid_input',
  });
});
test('images retain list order and native bytes; unsupported/missing/wrong-type media fail closed', async () => {
  const d = mkdtempSync(join(tmpdir(), 'sdk-input-'));
  directories.push(d);
  const a = join(d, 'a.png');
  const b = join(d, 'b.gif');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  writeFileSync(a, png);
  writeFileSync(b, 'GIF89a123');
  const envelope = JSON.stringify({
    inputVersion: 1,
    text: 'look',
    images: [
      { path: a, mediaType: 'image/png' },
      { path: b, mediaType: 'image/gif' },
    ],
  });
  const got = await parseSdkInput(envelope, 'json', true);
  expect(got.message.content.map((c) => c.type)).toEqual(['text', 'image', 'image']);
  expect(got.message.content[1]).toMatchObject({ source: { data: png.toString('base64') } });
  await expect(parseSdkInput(envelope, 'json', false)).rejects.toMatchObject({
    code: 'unsupported_input',
  });
  await expect(
    parseSdkInput(
      JSON.stringify({
        inputVersion: 1,
        text: 'x',
        images: [{ path: a, mediaType: 'image/jpeg' }],
      }),
      'json',
      true,
    ),
  ).rejects.toMatchObject({ code: 'unsupported_input' });
  await expect(
    parseSdkInput(
      JSON.stringify({
        inputVersion: 1,
        text: 'x',
        images: [{ path: join(d, 'missing'), mediaType: 'image/png' }],
      }),
      'json',
      true,
    ),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});

test('non-regular local files are refused without waiting for a FIFO writer', async () => {
  const d = mkdtempSync(join(tmpdir(), 'sdk-fifo-'));
  directories.push(d);
  const path = join(d, 'image-fifo');
  const result = Bun.spawnSync(['mkfifo', path]);
  expect(result.exitCode).toBe(0);
  await expect(
    parseSdkInput(
      JSON.stringify({ inputVersion: 1, text: 'x', images: [{ path, mediaType: 'image/png' }] }),
      'json',
      true,
    ),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});
