/** Native outcomes stay on the existing terminal event types used by callers. */
import type { Terminal } from '@yevgetman/sov-sdk/core/types';
import type { SessionStore } from '@yevgetman/sov-sdk/persistence/sessionStore';

export type NativeRunOutcome = 'completed' | 'needs_continuation' | 'interrupted' | 'failed';
export function nativeRunOutcome(terminal: Terminal): NativeRunOutcome {
  switch (terminal.reason) {
    case 'completed':
      return 'completed';
    case 'max_tokens':
    case 'max_turns':
    case 'checkin':
      return 'needs_continuation';
    case 'interrupted':
      return 'interrupted';
    case 'error':
      return 'failed';
  }
}

/** Verify the existing durable target. This must never create a requested id.
 * In-flight/unknown tool effects require operator review before automatic resume.
 * Completed journal receipts can repair a missing canonical tool-result batch. */
export function hasNativeRecoveryTarget(
  store: SessionStore | undefined,
  sessionId: string | null,
): boolean {
  if (!store || !sessionId) return false;
  try {
    if (!store.getSession(sessionId)) return false;
    const rows = store.loadMessages(sessionId);
    if (!rows.length || !rows.some((row) => row.role === 'user')) return false;
    const executions = store.loadToolExecutions?.(sessionId) ?? [];
    const intentKeys = new Set<string>();
    for (const row of rows)
      if (row.role === 'assistant')
        for (const block of row.content)
          if (block.type === 'tool_use') intentKeys.add(`${row.id}\0${block.id}`);
    if (
      executions.some(
        (receipt) =>
          !intentKeys.has(`${receipt.assistantMessageId}\0${receipt.toolUseId}`) ||
          receipt.state === 'started' ||
          receipt.state === 'unknown',
      )
    )
      return false;
    const receipts = new Map(
      executions.map(
        (receipt) => [`${receipt.assistantMessageId}\0${receipt.toolUseId}`, receipt] as const,
      ),
    );
    if (receipts.size !== executions.length) return false;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!row || row.role !== 'assistant') continue;
      const canonical = new Set<string>();
      let next = index + 1;
      for (; next < rows.length; next++) {
        const result = rows[next];
        if (!result || result.role === 'assistant') break;
        for (const block of result.content)
          if (block.type === 'tool_result') canonical.add(block.tool_use_id);
      }
      for (const block of row.content) {
        if (block.type !== 'tool_use') continue;
        const receipt = receipts.get(`${row.id}\0${block.id}`);
        if (
          receipt?.result &&
          (receipt.result.type !== 'tool_result' || receipt.result.tool_use_id !== block.id)
        )
          return false;
        if (canonical.has(block.id)) continue;
        if (!receipt || !['completed', 'interrupted'].includes(receipt.state) || !receipt.result)
          return false;
      }
      // Each user/tool-result segment is scanned exactly once, without slices.
      index = next - 1;
    }
    return true;
  } catch {
    return false;
  }
}
