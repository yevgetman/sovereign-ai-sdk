// Phase 18 T4 — Unit tests for the OpenAI SSE chunk builders. Pins
// the exact JSON wire shape: any drift here breaks downstream clients
// (Open WebUI, openai-python SDK, LibreChat).

import { describe, expect, test } from 'bun:test';
import {
  DONE_MARKER,
  buildDeltaChunk,
  buildFinalChunk,
  buildRoleChunk,
} from '../../../src/openai/streaming/chunks.js';

const ctx = { id: 'chatcmpl-abc', model: 'harness-default', created: 1700000000 };

describe('buildRoleChunk', () => {
  test('emits the canonical role-only delta with finish_reason:null', () => {
    expect(buildRoleChunk(ctx)).toEqual({
      id: 'chatcmpl-abc',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'harness-default',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
  });

  test('echoes the ctx model verbatim (no aliasing)', () => {
    const chunk = buildRoleChunk({ ...ctx, model: 'gpt-4-turbo' });
    expect(chunk.model).toBe('gpt-4-turbo');
  });
});

describe('buildDeltaChunk', () => {
  test('emits content delta', () => {
    expect(buildDeltaChunk('hello', ctx)).toEqual({
      id: 'chatcmpl-abc',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'harness-default',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    });
  });

  test('passes empty string through (rare but valid)', () => {
    const chunk = buildDeltaChunk('', ctx);
    expect(chunk.choices[0]?.delta.content).toBe('');
  });

  test('does NOT emit role on content-only chunks (role is head-only)', () => {
    const chunk = buildDeltaChunk('hi', ctx);
    expect(chunk.choices[0]?.delta).not.toHaveProperty('role');
  });

  test('finish_reason is null on content chunks', () => {
    expect(buildDeltaChunk('x', ctx).choices[0]?.finish_reason).toBeNull();
  });
});

describe('buildFinalChunk', () => {
  test('emits stop chunk with empty delta', () => {
    expect(buildFinalChunk('stop', ctx)).toEqual({
      id: 'chatcmpl-abc',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'harness-default',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
  });

  test('emits length reason when given', () => {
    const chunk = buildFinalChunk('length', ctx);
    expect(chunk.choices[0]?.finish_reason).toBe('length');
  });

  test('delta on the final chunk is an empty object (not omitted)', () => {
    const chunk = buildFinalChunk('stop', ctx);
    expect(chunk.choices[0]?.delta).toEqual({});
  });
});

describe('DONE_MARKER', () => {
  test('is the literal "[DONE]" string', () => {
    expect(DONE_MARKER).toBe('[DONE]');
  });
});
