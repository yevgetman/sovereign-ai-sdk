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

    // The assistant tool_use must remain immediately followed by its
    // matching user tool_result — that's the alignment invariant. The
    // synthetic-user bridge inserted by the alternation guard (#34) may
    // sit before them, so locate the tool_use rather than asserting a
    // fixed index.
    const toolUseIdx = result.tail.findIndex((m) => m.content[0]?.type === 'tool_use');
    expect(toolUseIdx).toBeGreaterThanOrEqual(0);
    expect(result.tail[toolUseIdx]?.role).toBe('assistant');
    expect(result.tail[toolUseIdx + 1]?.content[0]?.type).toBe('tool_result');
    expect(result.tail[toolUseIdx + 1]?.role).toBe('user');
    db.close();
  });

  test('persisted child history alternates user/assistant when tail starts with assistant', async () => {
    // Backlog #34 regression: when alignTailStart walks backward to keep an
    // assistant tool_use / user tool_result pair intact, tail[0] can be an
    // assistant message. The persisted child would then be
    //   [assistant_summary, assistant_tail0, user_tool_result, ...]
    // — two consecutive assistants. Anthropic 400s with `messages: roles
    // must alternate`. compactSession must keep the persisted child history
    // strictly alternating regardless of where the tail boundary lands.
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

    // Precondition: alignment kept the assistant tool_use / user tool_result
    // pair intact in the tail — the assistant tool_use is the first
    // *non-synthetic* message in the tail. (The guard inserts a synthetic
    // user before it.) If this assertion ever fails, the alignment logic
    // changed and this test no longer exercises the #34 hazard.
    const toolUseIdx = result.tail.findIndex((m) => m.content[0]?.type === 'tool_use');
    expect(toolUseIdx).toBeGreaterThanOrEqual(0);
    expect(result.tail[toolUseIdx]?.role).toBe('assistant');

    // Persisted child history must strictly alternate roles so Anthropic
    // doesn't 400 on the next provider call.
    const childMessages = db.loadMessages(result.newSessionId);
    expect(childMessages.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < childMessages.length; i++) {
      const prev = childMessages[i - 1];
      const curr = childMessages[i];
      expect(prev?.role).not.toBe(curr?.role);
    }
    db.close();
  });

  test('returns no-op result when head is empty (nothing to summarize)', async () => {
    // Backlog #36: when selectTailStart returns 0 (the entire history fits
    // within tailTokenBudget / minTailMessages), `head` is empty so the
    // summarizer has nothing meaningful to compress. The pre-fix behavior
    // still ran the summarizer, minted a child session, and reported
    // estimatedAfterTokens > estimatedBeforeTokens (after = before +
    // summary-message overhead). The TUI then rendered "auto-compacted —
    // 2247→2318 tokens" which looked like compaction was broken even
    // though the algorithm was correct (no-op-plus-summary-overhead).
    //
    // The fix: short-circuit and return a result with `noOp: true`, the
    // same parent id as newSessionId, and the original history unchanged
    // as the tail. Callers key off `result.noOp` to skip the SSE marker
    // (proactive/recovery), the session-id pivot (TUI), and the visual
    // child-id marker (terminalRepl).
    const db = openDb();
    const parent = createParent(db);
    const summarizeCalls: number[] = [];
    const history: Message[] = [
      { role: 'user', content: [text('hi')] },
      { role: 'assistant', content: [text('hello')] },
    ];
    for (const message of history) {
      db.saveMessage(parent, { role: message.role, content: message.content });
    }

    const result = await compactSession({
      db,
      sessionId: parent,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      systemPrompt: [],
      history,
      // Tail budget large enough to swallow both messages — selectTailStart
      // returns 0, head is empty.
      tailTokenBudget: 10_000,
      minTailMessages: 1,
      summarize: async (input) => {
        summarizeCalls.push(input.transcript.length);
        return 'unexpected — summarizer should not run on empty head';
      },
    });

    // Summarizer must NOT have been called — the early-return short-circuits
    // before the runSummarizer call.
    expect(summarizeCalls.length).toBe(0);

    // No-op shape: same id on both sides; explicit flag for callers to key off.
    expect(result.noOp).toBe(true);
    expect(result.parentSessionId).toBe(parent);
    expect(result.newSessionId).toBe(parent);

    // Token estimates: after === before (no summary message overhead added).
    expect(result.estimatedAfterTokens).toBe(result.estimatedBeforeTokens);

    // No new session minted — only the parent exists in the db.
    const lineage = db.getCompactionsForParent(parent);
    expect(lineage.length).toBe(0);

    // No new messages were persisted on the parent (the early-return skipped
    // the saveMessage loop).
    expect(db.loadMessages(parent)).toHaveLength(history.length);

    // The result's tail echoes the original history so callers that rebuild
    // their local history from result.tail still see the same messages.
    expect(result.tail).toHaveLength(history.length);
    expect(result.compactedMessages).toBe(0);
    db.close();
  });

  test('loadMessages(parentId) returns pre-compaction history; loadMessages(childId) returns post-compaction (no lineage walk on resume)', async () => {
    // Backlog #32 regression pin: `--resume <parentId>` after compaction
    // must load the parent's ORIGINAL pre-compaction history — NOT the
    // child's summary+tail. The contract works by construction:
    // `SessionDb.loadMessages(sessionId)` reads the `messages` table
    // filtered by exact `session_id` and never walks the
    // `compactions` lineage table. Resume passes the parent id directly
    // without lineage-walking. A future refactor that changed resume (or
    // `loadMessages`) to "auto-pivot to the latest descendant" would
    // silently break the "go back to where I was when this happened"
    // semantic. This test makes that regression loud.
    const db = openDb();
    const systemPrompt = [{ text: 'system rules', cacheable: true }];
    const parent = createParent(db, systemPrompt);
    // Six messages — substantial enough that the no-op short-circuit
    // (`compactor.ts:130`, head-empty) cannot fire. Combined with the
    // small `tailTokenBudget` below, this guarantees a real compaction:
    // head has compactable content, tail has the latest turn, summarizer
    // runs, child session is minted.
    const history: Message[] = [
      { role: 'user', content: [text('first user turn — earliest history')] },
      { role: 'assistant', content: [text('first assistant reply explaining context')] },
      { role: 'user', content: [text('second user follow-up question')] },
      { role: 'assistant', content: [text('second assistant answer with details')] },
      { role: 'user', content: [text('third user clarification')] },
      { role: 'assistant', content: [text('most recent assistant reply — tail boundary')] },
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
        summary: '## Active Task\n- Resume contract sanity check.',
        usage: { inputTokens: 200, outputTokens: 50 },
        estimatedCostUsd: 0.005,
        providerName: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        usedAuxiliary: true,
      }),
    });

    // Real compaction happened — child is a fresh session id, no-op did
    // not short-circuit. If either of these fail, the test stopped
    // exercising the contract and the rest of the assertions are
    // meaningless.
    expect(result.noOp).toBeFalsy();
    expect(result.newSessionId).not.toBe(result.parentSessionId);
    expect(result.parentSessionId).toBe(parent);

    // Lineage row persisted — a future resume implementation that wants
    // to walk lineage has the data available, but `loadMessages(parent)`
    // itself must not follow it.
    const lineage = db.getCompactionsForParent(parent);
    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.childSessionId).toBe(result.newSessionId);

    // CORE CONTRACT: `loadMessages(parentId)` returns the original
    // pre-compaction history verbatim. This is the assertion that would
    // fail if `loadMessages` were ever changed to walk lineage forward
    // and return the latest descendant's messages.
    const parentMessages = db.loadMessages(parent);
    expect(parentMessages).toHaveLength(history.length);
    expect(parentMessages[0]?.role).toBe(history[0]?.role);
    expect(blockText(parentMessages[0]?.content[0])).toBe(blockText(history[0]?.content[0]));
    expect(parentMessages.at(-1)?.role).toBe(history.at(-1)?.role);
    expect(blockText(parentMessages.at(-1)?.content[0])).toBe(
      blockText(history.at(-1)?.content[0]),
    );

    // Child session has the summary+tail shape — distinctly different
    // from the parent. If parent and child loaded the same messages,
    // either the lineage write clobbered the parent OR `loadMessages`
    // is silently routing parent→child (the regression we're guarding
    // against).
    const childMessages = db.loadMessages(result.newSessionId);
    expect(childMessages[0]?.role).toBe('assistant');
    expect(blockText(childMessages[0]?.content[0])).toContain(HANDOFF_SUMMARY_NOTE);
    // Parent's first message content differs from the child's first
    // message content — the strongest evidence the two ids resolve to
    // distinct message streams.
    expect(blockText(parentMessages[0]?.content[0])).not.toBe(
      blockText(childMessages[0]?.content[0]),
    );
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

  test('shouldCompactProactively triggers above 50 percent when threshold passed explicitly', () => {
    const messages: Message[] = [{ role: 'user', content: [text('x'.repeat(300))] }];
    expect(
      shouldCompactProactively({ messages, systemPrompt: [], contextLength: 100, threshold: 0.5 }),
    ).toBe(true);
    expect(
      shouldCompactProactively({
        messages,
        systemPrompt: [],
        contextLength: 10_000,
        threshold: 0.5,
      }),
    ).toBe(false);
  });

  test('shouldCompactProactively defaults to 75 percent threshold', () => {
    // 300-char text ≈ 75 tokens. At contextLength=100 with default
    // threshold=0.75, the limit is 75 — estimate must EXCEED limit to
    // trigger, so 100-char message (25 tokens) under limit, 400-char
    // (100 tokens) over.
    const small: Message[] = [{ role: 'user', content: [text('x'.repeat(100))] }];
    const big: Message[] = [{ role: 'user', content: [text('x'.repeat(400))] }];
    expect(
      shouldCompactProactively({ messages: small, systemPrompt: [], contextLength: 100 }),
    ).toBe(false);
    expect(shouldCompactProactively({ messages: big, systemPrompt: [], contextLength: 100 })).toBe(
      true,
    );
  });

  test('shouldCompactProactively returns false when system prompt alone exceeds the limit', () => {
    // Compaction can't make progress when the frozen system prompt is
    // bigger than the threshold — it only summarizes message history.
    // Avoid the runaway loop by refusing to fire.
    const messages: Message[] = [{ role: 'user', content: [text('x'.repeat(400))] }];
    expect(
      shouldCompactProactively({
        messages,
        systemPrompt: [{ text: 'y'.repeat(500), cacheable: true }],
        contextLength: 100,
      }),
    ).toBe(false);
  });
});

function blockText(block: ContentBlock | undefined): string {
  return block?.type === 'text' ? block.text : '';
}
