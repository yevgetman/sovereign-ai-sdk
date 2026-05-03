// Queued readline prompt adapter for preserving pasted multi-line input
// and surviving stdin EOF before all queued lines have been drained.

import type { Interface as ReadlineInterface } from 'node:readline/promises';

export type ReadlineQuestion = (
  prompt: string,
  options?: { signal?: AbortSignal },
) => Promise<string>;

/** Question fn with attached state introspection. The REPL loop reads
 *  `pending()` to know whether to keep iterating after readline has
 *  closed but lines remain in the queue (the piped-stdin case). */
export type QueuedQuestion = ReadlineQuestion & {
  /** Lines that arrived but haven't been handed out yet. */
  pending: () => number;
};

export function createQueuedQuestion(
  rl: ReadlineInterface,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): QueuedQuestion {
  const pendingLines: string[] = [];
  const waiters: Waiter[] = [];
  let closed = false;

  rl.on('line', (line: string) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(line);
      return;
    }
    pendingLines.push(line);
  });

  rl.on('close', () => {
    closed = true;
    const err = new Error('readline closed');
    while (waiters.length > 0) waiters.shift()?.reject(err);
  });

  const ask: ReadlineQuestion = async (prompt, options = {}) => {
    if (options.signal?.aborted) throw abortError();
    // Drain pendingLines BEFORE checking `closed`. Under piped stdin,
    // readline often receives every line and emits 'close' before the
    // first question() call returns — we must still hand out the
    // queued lines from that pre-close burst rather than throwing.
    const queued = pendingLines.shift();
    if (queued !== undefined) {
      write(prompt);
      return queued;
    }
    if (closed) throw new Error('readline closed');
    write(prompt);

    return await new Promise<string>((resolve, reject) => {
      const waiter = createWaiter(resolve, reject, waiters, options.signal);
      waiters.push(waiter);
      if (options.signal?.aborted) waiter.reject(abortError());
    });
  };
  const queued: QueuedQuestion = Object.assign(ask, {
    pending: () => pendingLines.length,
  });
  return queued;
}

type Waiter = {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
};

function createWaiter(
  resolve: (line: string) => void,
  reject: (err: Error) => void,
  waiters: Waiter[],
  signal?: AbortSignal,
): Waiter {
  let settled = false;
  const waiter: Waiter = {
    resolve: (line) => settle(() => resolve(line)),
    reject: (err) => settle(() => reject(err)),
  };
  function cleanup() {
    signal?.removeEventListener('abort', onAbort);
  }
  function settle(fn: () => void) {
    if (settled) return;
    settled = true;
    cleanup();
    fn();
  }
  function onAbort() {
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    settle(() => reject(abortError()));
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  return waiter;
}

function abortError(): Error {
  const err = new Error('readline question aborted');
  err.name = 'AbortError';
  return err;
}
