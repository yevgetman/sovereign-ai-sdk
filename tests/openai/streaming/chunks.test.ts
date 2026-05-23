// Phase 18 T4 — Unit tests for the OpenAI SSE chunk builders. Pins
// the exact JSON wire shape: any drift here breaks downstream clients
// (Open WebUI, openai-python SDK, LibreChat).

import { describe, expect, test } from 'bun:test';
import {
  DONE_MARKER,
  buildDeltaChunk,
  buildFinalChunk,
  buildProgressPayload,
  buildRoleChunk,
  buildToolCallsChunk,
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

describe('buildToolCallsChunk', () => {
  test('emits a tool_calls delta with stringified arguments', () => {
    const chunk = buildToolCallsChunk(
      [{ id: 'call_1', name: 'FileRead', input: { path: '/x' } }],
      ctx,
    );
    expect(chunk).toEqual({
      id: 'chatcmpl-abc',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'harness-default',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'FileRead', arguments: '{"path":"/x"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  });

  test('emits multiple tool_calls with sequential indices', () => {
    const chunk = buildToolCallsChunk(
      [
        { id: 'a', name: 'A', input: {} },
        { id: 'b', name: 'B', input: { foo: 1 } },
      ],
      ctx,
    );
    expect(chunk.choices[0]?.delta.tool_calls).toHaveLength(2);
    expect(chunk.choices[0]?.delta.tool_calls[0]?.index).toBe(0);
    expect(chunk.choices[0]?.delta.tool_calls[1]?.index).toBe(1);
    expect(chunk.choices[0]?.delta.tool_calls[1]?.function.arguments).toBe('{"foo":1}');
  });

  test('arguments stringify null/undefined input as empty object', () => {
    const chunk = buildToolCallsChunk([{ id: 'call_x', name: 'NoArgs', input: undefined }], ctx);
    expect(chunk.choices[0]?.delta.tool_calls[0]?.function.arguments).toBe('{}');
  });

  test('finish_reason is null on tool_calls chunks (harness runs tools internally)', () => {
    // D9: the client never sees `finish_reason: 'tool_calls'` because
    // the harness loops to terminal within the same request — the only
    // terminal stop reasons surfaced are 'stop' or 'length'.
    const chunk = buildToolCallsChunk([{ id: 'c', name: 'N', input: {} }], ctx);
    expect(chunk.choices[0]?.finish_reason).toBeNull();
  });

  test('echoes the ctx id/model/created verbatim', () => {
    const chunk = buildToolCallsChunk([{ id: 'c', name: 'N', input: {} }], {
      id: 'chatcmpl-zzz',
      model: 'gpt-4-turbo',
      created: 1800000000,
    });
    expect(chunk.id).toBe('chatcmpl-zzz');
    expect(chunk.model).toBe('gpt-4-turbo');
    expect(chunk.created).toBe(1800000000);
  });
});

describe('buildProgressPayload', () => {
  test('JSON-encodes the progress event', () => {
    const payload = buildProgressPayload({ tool_use_id: 'call_1', output: 'done' });
    expect(JSON.parse(payload)).toEqual({ tool_use_id: 'call_1', output: 'done' });
  });

  test('omits output when undefined', () => {
    const payload = buildProgressPayload({ tool_use_id: 'call_1' });
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed).toEqual({ tool_use_id: 'call_1' });
    expect(parsed).not.toHaveProperty('output');
  });

  test('omits is_error when false (absence signals success)', () => {
    const payload = buildProgressPayload({ tool_use_id: 'call_1', is_error: false });
    expect(JSON.parse(payload)).toEqual({ tool_use_id: 'call_1' });
  });

  test('includes is_error: true when failure', () => {
    const payload = buildProgressPayload({
      tool_use_id: 'call_1',
      output: 'permission denied',
      is_error: true,
    });
    expect(JSON.parse(payload)).toEqual({
      tool_use_id: 'call_1',
      output: 'permission denied',
      is_error: true,
    });
  });
});
