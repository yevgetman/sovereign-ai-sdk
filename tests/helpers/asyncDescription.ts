// Shared test fixtures for the async-rejecting tool-description class (G1/G2/G3/G5).
//
// The `Tool.description` contract is `(input) => Promise<string> | string`, so an
// async description is legal. In a SYNCHRONOUS static-assembly context the SDK
// degrades an async description to the tool name — but if the description
// REJECTS, dropping that Promise with no `.catch()` leaves an unhandled rejection
// that kills the host process (exit 1 on Node ≥15 and Bun). These helpers build
// such a tool and detect any process-level unhandled rejection a code path leaves
// behind.

import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import type { Tool } from '@yevgetman/sov-sdk/tool/types';
import { z } from 'zod';

/** A consumer tool whose description is async AND rejects (the crash class). */
export function asyncRejectingDescriptionTool(name = 'async_reject_tool'): Tool<unknown, unknown> {
  return buildTool({
    name,
    description: async () => {
      throw new Error('boom');
    },
    inputSchema: z.object({ msg: z.string() }),
    async call(input) {
      return { data: input };
    },
  }) as unknown as Tool<unknown, unknown>;
}

/** A consumer tool whose description is async and RESOLVES to a string — legal,
 *  but still degrades to the tool name in synchronous static contexts. */
export function asyncResolvingDescriptionTool(name = 'async_resolve_tool'): Tool<unknown, unknown> {
  return buildTool({
    name,
    description: async () => 'resolved later',
    inputSchema: z.object({ msg: z.string() }),
    async call(input) {
      return { data: input };
    },
  }) as unknown as Tool<unknown, unknown>;
}

/** Drive `fn` (a static-description path) and return any process-level
 *  unhandled rejections it leaves behind. Runtime-agnostic (Node ≥15 + Bun): a
 *  temporary `unhandledRejection` listener records rejections; two macrotask
 *  ticks let a dropped microtask-level rejection surface before the listener is
 *  removed. Attaching a listener also suppresses the default process-kill, so a
 *  RED run reports as a non-empty array rather than aborting the test file. */
export async function collectUnhandledRejections(fn: () => void): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const listener = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', listener);
  try {
    fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
  return rejections;
}
