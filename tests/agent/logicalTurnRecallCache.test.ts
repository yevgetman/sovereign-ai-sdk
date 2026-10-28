// A logical turn rehydrates the stored prompt without the recall or memory fence.
// Later segments must reuse the first read, still send one fence, and read again
// only when the corpus or memory files change.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunResult } from '@yevgetman/sov-sdk/agent/createAgent';
import {
  type LogicalTurnSupervisorOptions,
  superviseLogicalTurn,
} from '@yevgetman/sov-sdk/agent/logicalTurn';
import { query } from '@yevgetman/sov-sdk/core/query';
import { prependRecall } from '@yevgetman/sov-sdk/core/recallInjection';
import type {
  AssistantMessage,
  Message,
  RecallTurn,
  Terminal,
} from '@yevgetman/sov-sdk/core/types';
import { formatMemorySnapshot } from '@yevgetman/sov-sdk/memory/injection';
import { type MemoryRuntime, createDefaultMemoryManager } from '@yevgetman/sov-sdk/memory/provider';
import { createInMemorySessionStore } from '@yevgetman/sov-sdk/persistence/inMemoryStore';
import type { LLMProvider, ProviderRequest } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool, ToolContext } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';
import { createFsPersist } from '../../src/learning-layer/adapters/harness/persistFs.js';
import { createLearningLayer } from '../../src/learning-layer/index.js';
import { instinctCorpusStamp } from '../../src/learning-layer/recall/readInstincts.js';
import { serializeInstinct } from '../../src/learning/instinctSerde.js';
import type { Instinct } from '../../src/learning/types.js';

const prompt = 'please run the test suite now';
const toolContext: ToolContext = {
  cwd: '/tmp/project',
  bundleRoot: '/tmp/project',
  sessionId: 'session-1',
};

const echoTool = buildTool({
  name: 'Echo',
  description: () => 'echo input',
  inputSchema: z.object({ text: z.string() }),
  async call(input) {
    return { data: { echoed: input.text } };
  },
}) as unknown as Tool<unknown, unknown>;

const toolAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tool-1', name: 'Echo', input: { text: 'hello' } }],
};

const textAnswer: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
};

function userText(request: ProviderRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (!message || message.role !== 'user') continue;
    if (message.content.some((block) => block.type === 'tool_result')) continue;
    const block = message.content.find((part) => part.type === 'text');
    if (block?.type === 'text') return block.text;
  }
  return '';
}

function fenceCount(text: string, close: string): number {
  return text.split(close).length - 1;
}

async function drain(gen: ReturnType<typeof query>): Promise<Terminal> {
  while (true) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

function supervise(
  runSegment: LogicalTurnSupervisorOptions['runSegment'],
  extra: Partial<LogicalTurnSupervisorOptions> = {},
) {
  const store = createInMemorySessionStore();
  store.createSession({ sessionId: 'session-1', provider: 'fixture', model: 'fixture-model' });
  store.saveMessage('session-1', {
    role: 'user',
    content: [{ type: 'text', text: prompt }],
  });
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  let work = 0;
  return superviseLogicalTurn({
    store,
    binding: { provider: 'fixture', model: 'fixture-model', cwd: '/tmp/project' },
    sessionId: 'session-1',
    initialMessages: messages,
    rehydrate: () => messages.map((message) => ({ ...message, content: [...message.content] })),
    recoverySafe: () => true,
    // Transcript ids are not progress. These segments do tool work, so the
    // fixture reports a changed owned result instead of a new row id.
    progressSnapshot: () => ({
      transcriptIds: ['stable'],
      transcriptCount: 1,
      receipts: [],
      cursor: null,
      tasks: [{ id: 'work', state: 'running', result: work++ }],
    }),
    runSegment,
    ...extra,
  });
}

function segmentResult(terminal: Terminal, messages: Message[]): RunResult {
  return {
    sessionId: 'session-1',
    terminal,
    iterationsUsed: 1,
    toolCallCount: terminal.reason === 'max_turns' ? 1 : 0,
    distinctToolNames: [],
    messages,
    ...(terminal.reason === 'completed' ? { finalAssistant: textAnswer } : {}),
  };
}

describe('logical turn recall cache', () => {
  test('continuation segments reuse one corpus read and one memory snapshot', async () => {
    let recallGeneration = 1;
    let memoryGeneration = 1;
    let scans = 0;
    let lists = 0;
    let reads = 0;
    let prefetches = 0;
    const seen: string[] = [];
    const recalled: Array<string | undefined> = [];
    const recall: RecallTurn = async (userText) => {
      scans += 1;
      lists += 1;
      reads += 2;
      recalled.push(userText);
      return { injectionText: `lesson-${recallGeneration}`, lessons: [] };
    };
    recall.corpusStamp = async () => `corpus:${recallGeneration}`;
    const memory: MemoryRuntime = {
      async prefetchSnapshot() {
        prefetches += 1;
        return `<memory-context>mem-${memoryGeneration}</memory-context>`;
      },
      snapshotStamp: async () => `memory:${memoryGeneration}`,
      async syncTurn() {},
      async onMemoryWrite() {},
      async onDelegation() {},
    };
    let calls = 0;
    const provider: LLMProvider = {
      name: 'recall-cache',
      async *stream(request) {
        seen.push(userText(request));
        calls += 1;
        if (calls < 4) {
          yield { type: 'message_start' };
          yield { type: 'message_stop', stop_reason: 'tool_use' };
          yield { type: 'assistant_message', message: toolAnswer };
          return toolAnswer;
        }
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: textAnswer };
        return textAnswer;
      },
    };
    const outcome = await supervise(async (segment) => {
      if (segment.segment === 4) {
        recallGeneration = 2;
        memoryGeneration = 2;
      }
      const terminal = await drain(
        query({
          provider,
          model: 'fixture-model',
          messages: segment.messages,
          systemPrompt: [{ text: 'system', cacheable: true }],
          maxTokens: 32,
          maxTurns: 1,
          continuation: segment.continuation,
          logicalTurn: true,
          tools: [echoTool],
          toolContext,
          recall,
          memoryManager: memory,
        }),
      );
      return segmentResult(terminal, segment.messages);
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.counters.segments).toBe(4);
    expect(scans).toBe(2);
    expect(lists).toBe(2);
    expect(reads).toBe(4);
    expect(prefetches).toBe(2);
    expect(recalled).toEqual([prompt, prompt]);
    expect(seen).toHaveLength(4);
    for (const text of seen.slice(0, 3)) {
      expect(text).toContain('lesson-1');
      expect(text).toContain('mem-1');
      expect(fenceCount(text, '</recall-context>')).toBe(1);
      expect(fenceCount(text, '</memory-context>')).toBe(1);
      expect(text.endsWith(prompt)).toBe(true);
    }
    const refreshed = seen[3] ?? '';
    expect(refreshed).toContain('lesson-2');
    expect(refreshed).not.toContain('lesson-1');
    expect(refreshed).toContain('mem-2');
    expect(refreshed).not.toContain('mem-1');
    expect(fenceCount(refreshed, '</recall-context>')).toBe(1);
    expect(fenceCount(refreshed, '</memory-context>')).toBe(1);
  });

  test('a fence already in the segment copy is not stacked or reread', async () => {
    let scans = 0;
    let prefetches = 0;
    const recall: RecallTurn = async () => {
      scans += 1;
      return { injectionText: 'fresh-lesson', lessons: [] };
    };
    recall.corpusStamp = async () => 'corpus:1';
    const memory: MemoryRuntime = {
      async prefetchSnapshot() {
        prefetches += 1;
        return formatMemorySnapshot({ memory: 'fresh-memory' });
      },
      snapshotStamp: async () => 'memory:1',
      async syncTurn() {},
      async onMemoryWrite() {},
      async onDelegation() {},
    };
    const stored = `${formatMemorySnapshot({ memory: 'stored-memory' })}\n\n${prependRecall(prompt, 'stored-lesson')}`;
    const fenced: Message[] = [{ role: 'user', content: [{ type: 'text', text: stored }] }];
    const raw: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    const seen: string[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      name: 'fenced-copy',
      async *stream(request) {
        seen.push(userText(request));
        calls += 1;
        if (calls === 1) {
          yield { type: 'message_start' };
          yield { type: 'message_stop', stop_reason: 'tool_use' };
          yield { type: 'assistant_message', message: toolAnswer };
          return toolAnswer;
        }
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: textAnswer };
        return textAnswer;
      },
    };
    const outcome = await supervise(
      async (segment) => {
        const terminal = await drain(
          query({
            provider,
            model: 'fixture-model',
            messages: segment.messages,
            systemPrompt: [{ text: 'system', cacheable: true }],
            maxTokens: 32,
            maxTurns: 1,
            continuation: segment.continuation,
            logicalTurn: true,
            tools: [echoTool],
            toolContext,
            recall,
            memoryManager: memory,
          }),
        );
        return segmentResult(terminal, segment.messages);
      },
      {
        initialMessages: raw,
        rehydrate: () => fenced.map((message) => ({ ...message, content: [...message.content] })),
      },
    );
    expect(outcome.status).toBe('completed');
    expect(scans).toBe(1);
    expect(prefetches).toBe(1);
    expect(seen[1]).toBe(stored);
    expect(fenceCount(seen[1] ?? '', '</recall-context>')).toBe(1);
    expect(fenceCount(seen[1] ?? '', '</memory-context>')).toBe(1);
    expect(seen[1]).toContain('stored-lesson');
    expect(seen[1]).not.toContain('fresh-lesson');
    expect(seen[1]).toContain('stored-memory');
    expect(seen[1]).not.toContain('fresh-memory');
  });

  test('a tool-result tail still recalls the human prompt once', async () => {
    const recalled: Array<string | undefined> = [];
    const recall: RecallTurn = async (userText) => {
      recalled.push(userText);
      return { injectionText: 'tail-lesson', lessons: [] };
    };
    const steer = 'steer text that is not the prompt';
    const tail: Message[] = [
      { role: 'user', content: [{ type: 'text', text: prompt }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Echo', input: { text: 'x' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'result data' },
          { type: 'text', text: steer },
        ],
      },
    ];
    const seen: string[] = [];
    let calls = 0;
    const provider: LLMProvider = {
      name: 'tool-tail',
      async *stream(request) {
        seen.push(userText(request));
        calls += 1;
        if (calls === 1) {
          yield { type: 'message_start' };
          yield { type: 'message_stop', stop_reason: 'tool_use' };
          yield { type: 'assistant_message', message: toolAnswer };
          return toolAnswer;
        }
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'message_stop', stop_reason: 'end_turn' };
        yield { type: 'assistant_message', message: textAnswer };
        return textAnswer;
      },
    };
    const outcome = await supervise(
      async (segment) => {
        const terminal = await drain(
          query({
            provider,
            model: 'fixture-model',
            messages: segment.messages,
            systemPrompt: [{ text: 'system', cacheable: true }],
            maxTokens: 32,
            maxTurns: 1,
            continuation: segment.continuation,
            logicalTurn: true,
            tools: [echoTool],
            toolContext,
            recall,
          }),
        );
        return segmentResult(terminal, segment.messages);
      },
      { rehydrate: () => tail.map((message) => ({ ...message, content: [...message.content] })) },
    );
    expect(outcome.status).toBe('completed');
    expect(recalled).toEqual([prompt]);
    expect(seen[1]?.endsWith(prompt)).toBe(true);
    expect(seen[1]).toContain('tail-lesson');
    expect(fenceCount(seen[1] ?? '', '</recall-context>')).toBe(1);
    expect(seen[1]).not.toContain(steer);
    const steered = tail[2];
    expect(steered?.content.find((block) => block.type === 'text')).toEqual({
      type: 'text',
      text: steer,
    });
  });

  test('native instinct list and read run once until the corpus or memory files change', async () => {
    const home = mkdtempSync(join(tmpdir(), 'recall-cache-'));
    try {
      const projectId = 'cacheproj';
      const persist = createFsPersist(home);
      const instinct = (id: string, action: string): Instinct => ({
        id,
        trigger: 'run the test suite',
        action,
        confidence: 0.9,
        evidence_count: 1,
        domain: 'testing',
        scope: id === 'global-one' ? 'global' : 'project',
        project_id: id === 'global-one' ? null : projectId,
        project_name: null,
        created_at: '2026-06-03T00:00:00.000Z',
        last_evidence_at: '2026-06-03T00:00:00.000Z',
        observation_ids: ['obs-1'],
      });
      await persist.write(
        `learning/${projectId}/instincts/project-one.md`,
        serializeInstinct(instinct('project-one', 'project action one'), ''),
      );
      await persist.write(
        'learning/_global/instincts/global-one.md',
        serializeInstinct(instinct('global-one', 'global action one'), ''),
      );
      mkdirSync(join(home, 'memory'), { recursive: true });
      writeFileSync(join(home, 'memory', 'MEMORY.md'), 'remember the first snapshot');
      let lists = 0;
      let reads = 0;
      const counting = {
        list: async (prefix: string) => {
          lists += 1;
          return persist.list(prefix);
        },
        read: async (key: string) => {
          reads += 1;
          return persist.read(key);
        },
        write: (key: string, value: string) => persist.write(key, value),
        remove: (key: string) => persist.remove(key),
      };
      const layer = createLearningLayer({
        reason: {
          async complete() {
            return '';
          },
        },
        persist: counting,
      });
      const recall: RecallTurn = (latestUserText) =>
        layer.recall({
          projectId,
          latestUserText,
          tokenBudget: 1200,
          maxLessons: 8,
        });
      recall.corpusStamp = async () => instinctCorpusStamp(home, projectId);
      const inner = createDefaultMemoryManager(home);
      let prefetches = 0;
      const memory: MemoryRuntime = {
        async prefetchSnapshot(user) {
          prefetches += 1;
          return inner.prefetchSnapshot(user);
        },
        snapshotStamp: () => inner.snapshotStamp(),
        syncTurn: (user, assistant) => inner.syncTurn(user, assistant),
        onMemoryWrite: (change) => inner.onMemoryWrite(change),
        onDelegation: (task, result) => inner.onDelegation(task, result),
      };
      const seen: string[] = [];
      let calls = 0;
      const provider: LLMProvider = {
        name: 'native-corpus',
        async *stream(request) {
          seen.push(userText(request));
          calls += 1;
          if (calls < 4) {
            yield { type: 'message_start' };
            yield { type: 'message_stop', stop_reason: 'tool_use' };
            yield { type: 'assistant_message', message: toolAnswer };
            return toolAnswer;
          }
          yield { type: 'message_start' };
          yield { type: 'text_delta', text: 'ok' };
          yield { type: 'message_stop', stop_reason: 'end_turn' };
          yield { type: 'assistant_message', message: textAnswer };
          return textAnswer;
        },
      };
      const outcome = await supervise(async (segment) => {
        if (segment.segment === 4) {
          await persist.write(
            'learning/_global/instincts/global-one.md',
            serializeInstinct(instinct('global-one', 'global action two'), ''),
          );
          writeFileSync(join(home, 'memory', 'MEMORY.md'), 'remember the second snapshot');
        }
        const terminal = await drain(
          query({
            provider,
            model: 'fixture-model',
            messages: segment.messages,
            systemPrompt: [{ text: 'system', cacheable: true }],
            maxTokens: 32,
            maxTurns: 1,
            continuation: segment.continuation,
            logicalTurn: true,
            tools: [echoTool],
            toolContext,
            recall,
            memoryManager: memory,
          }),
        );
        return segmentResult(terminal, segment.messages);
      });
      expect(outcome.status).toBe('completed');
      expect(outcome.counters.segments).toBe(4);
      // Two prefixes and two files on the first segment, then again after the files change.
      expect(lists).toBe(4);
      expect(reads).toBe(4);
      expect(prefetches).toBe(2);
      for (const text of seen.slice(0, 3)) {
        expect(text).toContain('project action one');
        expect(text).toContain('global action one');
        expect(text).toContain('remember the first snapshot');
        expect(fenceCount(text, '</recall-context>')).toBe(1);
        expect(fenceCount(text, '</memory-context>')).toBe(1);
      }
      const refreshed = seen[3] ?? '';
      expect(refreshed).toContain('global action two');
      expect(refreshed).not.toContain('global action one');
      expect(refreshed).toContain('project action one');
      expect(refreshed).toContain('remember the second snapshot');
      expect(refreshed).not.toContain('remember the first snapshot');
      expect(fenceCount(refreshed, '</recall-context>')).toBe(1);
      expect(fenceCount(refreshed, '</memory-context>')).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
