import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ContentBlock, UserMessage } from '@yevgetman/sov-sdk/core/types';

export class SdkInputError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'unsupported_input',
    message: string,
  ) {
    super(message);
  }
}
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES_BYTES = 40 * 1024 * 1024;
const MEDIA = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k));
}
function mediaMatches(bytes: Buffer, media: string): boolean {
  if (media === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (media === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (media === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString());
  return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
}
export async function parseSdkInput(
  raw: string,
  format: unknown,
  supportsImages: boolean,
): Promise<{ message: UserMessage; instructions?: string }> {
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES)
    throw new SdkInputError('invalid_input', 'stdin exceeds the input limit');
  let text: string;
  let instructions: string | undefined;
  let images: unknown[] = [];
  if (format === undefined || format === 'text') text = raw;
  else if (format === 'json') {
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new SdkInputError('invalid_input', 'stdin is not valid JSON');
    }
    if (
      !object(input) ||
      !keys(input, ['inputVersion', 'text', 'instructions', 'images']) ||
      input.inputVersion !== 1 ||
      typeof input.text !== 'string' ||
      (input.instructions !== undefined && typeof input.instructions !== 'string') ||
      (input.images !== undefined && !Array.isArray(input.images))
    ) {
      throw new SdkInputError('invalid_input', 'invalid inputVersion 1 envelope');
    }
    text = input.text;
    instructions = input.instructions as string | undefined;
    images = (input.images ?? []) as unknown[];
  } else throw new SdkInputError('invalid_input', 'input format must be text or json');
  if (!text.trim() && images.length === 0)
    throw new SdkInputError('invalid_input', 'stdin prompt is empty');
  if (images.length > 10) throw new SdkInputError('invalid_input', 'too many images');
  if (images.length && !supportsImages)
    throw new SdkInputError('unsupported_input', 'selected route does not support images');
  const content: ContentBlock[] = [{ type: 'text', text }];
  let total = 0;
  for (const item of images) {
    if (
      !object(item) ||
      !keys(item, ['path', 'mediaType']) ||
      typeof item.path !== 'string' ||
      !isAbsolute(item.path) ||
      typeof item.mediaType !== 'string' ||
      !MEDIA.includes(item.mediaType)
    ) {
      throw new SdkInputError('invalid_input', 'invalid local image reference');
    }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(item.path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size < 1 ||
        stat.size > MAX_IMAGE_BYTES ||
        total + stat.size > MAX_IMAGES_BYTES
      )
        throw new SdkInputError('invalid_input', 'image exceeds the file limit');
      // One extra byte catches concurrent growth without an unbounded readFile.
      const buffer = Buffer.alloc(stat.size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead !== stat.size)
        throw new SdkInputError('invalid_input', 'image changed during read');
      const bytes = buffer.subarray(0, bytesRead);
      if (!mediaMatches(bytes, item.mediaType))
        throw new SdkInputError('unsupported_input', 'image does not match its media type');
      total += bytesRead;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: item.mediaType, data: bytes.toString('base64') },
      });
    } catch (err) {
      if (err instanceof SdkInputError) throw err;
      throw new SdkInputError('invalid_input', 'cannot read local image');
    } finally {
      await file?.close();
    }
  }
  return {
    message: { role: 'user', content },
    ...(instructions !== undefined ? { instructions } : {}),
  };
}
export async function readSdkStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  // Preserve regular-file stdin on Linux after async CLI startup as well as
  // piped stdin; keep the streaming byte limit before buffering each chunk.
  for await (const part of Bun.stdin.stream()) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += bytes.length;
    if (length > MAX_INPUT_BYTES)
      throw new SdkInputError('invalid_input', 'stdin exceeds the input limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
