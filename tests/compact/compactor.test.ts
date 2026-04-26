import { describe, expect, test } from 'bun:test';
import { SessionDb } from '../../src/agent/sessionDb.js';
import {
  type CompactSummarizerInput,
  HANDOFF_SUMMARY_NOTE,
  compactSession,
  pruneToolResultsForCompaction,
  shouldCompactProactively,
} from '../../src/compact/compactor.js';
import type { ContentBlock, Message, SystemSegment } from '../../src/core/types.js';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });

function openDb(): SessionDb {
  return SessionDb.open({ path: ':memory:' });
}

function createParent(db: SessionDb, systemPrompt: SystemSegment[] = []): string {
  return db.createSession({
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    platform: 'cli',
    systemPrompt,
    metadata: { bundleRoot: '/tmp/bundle', contextLength: 1000 },
  });
}

describe('compactSession', () => {
  test('creates a child session with summary, tail, lineage, and compaction cost lanes', async () => {
    const db = openDb();
    const systemPrompt = [{ text: 'system rules', cacheable: true }];
    const parent = createParent(db, systemPrompt);
    const history: Message[] = [
      { role: 'user', content: [text('old decision: keep alpha')] },
      { role: 'assistant', content: [text('resolved: alpha is keep')] },
      { role: 'user', content: [text('current task: continue')] },
    ];
    for (const message of history) {
      db.saveMessage(parent, { role: message.role, content: message.content });
    }

    const result = await compactSession({
      db,
      sessionId: parent,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      systemPrompt,
      history,
      tailTokenBudget: 1,
      minTailMessages: 1,
      summarize: async () => ({
        summary: '## Active Task\n- Continue.',
        usage: { inputTokens: 100, outputTokens: 25 },
        estimatedCostUsd: 0.004,
        providerName: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        usedAuxiliary: true,
      }),
    });

    const parentSession = db.getSession(parent);
    const childSession = db.getSession(result.newSessionId);
    const childMessages = db.loadMessages(result.newSessionId);
    expect(result.parentSessionId).toBe(parent);
    expect(childSession?.parentSessionId).toBe(parent);
    expect(parentSession?.lastUpdated).toBeLessThanOrEqual(childSession?.lastUpdated ?? 0);
    const links = db.getCompactionsForParent(parent);
    expect(links).toHaveLength(1);
    expect(links[0]?.childSessionId).toBe(result.newSessionId);
    expect(db.loadMessages(parent)).toHaveLength(3);
    expect(childMessages[0]?.role).toBe('assistant');
    expect(blockText(childMessages[0]?.content[0])).toContain(HANDOFF_SUMMARY_NOTE);
    expect(blockText(childMessages.at(-1)?.content[0])).toContain('current task');
    const cost = db.getSessionCost(result.newSessionId);
    expect(cost.compactionInputTokens).toBe(100);
    expect(cost.compactionOutputTokens).toBe(25);
    expect(cost.estimatedCompactionCostUsd).toBe(0.004);
    db.close();
  });

  test('pre-prunes old tool results before summarization', async () => {
    const db = openDb();
    const parent = createParent(db);
    const hugeOutput = 'x'.repeat(2_000);
    let seen: CompactSummarizerInput | undefined;
    const history: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat big.log' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: hugeOutput }],
      },
      { role: 'user', content: [text('latest user turn')] },
    ];

    await compactSession({
      db,
      sessionId: parent,
      model: 'm',
      providerName: 'p',
      systemPrompt: [],
      history,
      tailTokenBudget: 1,
      minTailMessages: 1,
      summarize: async (input) => {
        seen = input;
        return 'summary';
      },
    });

    expect(seen?.transcript).toContain('tool_result pruned');
    expect(seen?.transcript).toContain('cat big.log');
    expect(seen?.transcript).not.toContain(hugeOutput);
    db.close();
  });

  test('does not split assistant tool_use / user tool_result pairs into the tail', async () => {
    const db = openDb();
    const parent = createParent(db);
    const history: Message[] = [
      { role: 'user', content: [text('older')] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/tmp/project' }],
      },
    ];

    const result = await compactSession({
      db,
      sessionId: parent,
      model: 'm',
      providerName: 'p',
      systemPrompt: [],
      history,
      tailTokenBudget: 1,
      minTailMessages: 1,
      summarize: async () => 'summary',
    });

    expect(result.tail).toHaveLength(2);
    expect(result.tail[0]?.content[0]?.type).toBe('tool_use');
    expect(result.tail[1]?.content[0]?.type).toBe('tool_result');
    db.close();
  });

  test('feeds previous handoff summaries into iterative summary merging', async () => {
    const db = openDb();
    const parent = createParent(db);
    const previous = `${HANDOFF_SUMMARY_NOTE}\n\n## Active Task\n- Prior compacted work.`;
    let seen: CompactSummarizerInput | undefined;
    const history: Message[] = [
      { role: 'assistant', content: [text(previous)] },
      { role: 'user', content: [text('older after previous summary')] },
      { role: 'user', content: [text('latest')] },
    ];

    await compactSession({
      db,
      sessionId: parent,
      model: 'm',
      providerName: 'p',
      systemPrompt: [],
      history,
      tailTokenBudget: 1,
      minTailMessages: 1,
      summarize: async (input) => {
        seen = input;
        return 'summary';
      },
    });

    expect(seen?.previousSummary).toContain('Prior compacted work');
    db.close();
  });
});

describe('compaction helpers', () => {
  test('pruneToolResultsForCompaction leaves short results intact', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'short' }] },
    ];
    expect(pruneToolResultsForCompaction(messages)).toEqual(messages);
  });

  test('shouldCompactProactively triggers above 50 percent context by default', () => {
    const messages: Message[] = [{ role: 'user', content: [text('x'.repeat(300))] }];
    expect(shouldCompactProactively({ messages, systemPrompt: [], contextLength: 100 })).toBe(true);
    expect(shouldCompactProactively({ messages, systemPrompt: [], contextLength: 10_000 })).toBe(
      false,
    );
  });
});

function blockText(block: ContentBlock | undefined): string {
  return block?.type === 'text' ? block.text : '';
}
