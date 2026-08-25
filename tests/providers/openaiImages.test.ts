// IMAGES ON THE OPENAI-FORMAT WIRE.
//
// The MCP layer now carries a tool's image through to the conversation, but on
// this transport `messagesToOpenAI` rendered every image block as the literal
// "[image omitted: image/png]" — so a carried screenshot still died one step
// later, at the provider boundary. The openrouter lane is the one that matters
// here: it is where the vision-capable models actually run.
//
// OpenAI-format vision is `image_url` content parts with a data URL.

import { describe, expect, test } from 'bun:test';
import type { Message } from '@yevgetman/sov-sdk/core/types';
import { messagesToOpenAI } from '@yevgetman/sov-sdk/providers/openai';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const withImage: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'here is the render' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ],
  },
];

describe('messagesToOpenAI — image content', () => {
  test('emits an image_url data URL, not a placeholder', () => {
    const out = messagesToOpenAI(withImage, []);
    const user = out.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    expect(Array.isArray(user?.content)).toBe(true);

    const parts = user?.content as Array<Record<string, unknown>>;
    const image = parts.find((p) => p.type === 'image_url');
    expect(image).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG}` },
    });
    expect(JSON.stringify(out)).not.toContain('image omitted');
  });

  test('keeps the accompanying text alongside the image', () => {
    const out = messagesToOpenAI(withImage, []);
    const parts = out.find((m) => m.role === 'user')?.content as Array<Record<string, unknown>>;
    const text = parts.find((p) => p.type === 'text');
    expect(text).toEqual({ type: 'text', text: 'here is the render' });
  });

  test('a text-only message still emits a PLAIN STRING content — byte-identical', () => {
    // Every other lane on this transport (sov/vLLM, Ollama, OpenAI proper)
    // shares this function. A text turn must serialise exactly as it always did.
    const out = messagesToOpenAI(
      [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
      [],
    );
    expect(out).toEqual([{ role: 'user', content: 'plain' }]);
  });

  test('an image with no accompanying text still produces a valid parts array', () => {
    const out = messagesToOpenAI(
      [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          ],
        },
      ],
      [],
    );
    const parts = out.find((m) => m.role === 'user')?.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe('image_url');
  });
});
