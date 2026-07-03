// Bounded UTF-8 file read for local context/hint files. Context files
// (AGENTS.md / CONTEXT.md / .cursorrules) are treated as untrusted — an agent
// operating on an arbitrary repo may encounter a multi-GB file. Reading such a
// file whole with readFileSync (then truncating the string afterward) allocates
// the entire file into memory first, stalling the event loop and risking OOM.
//
// This caps the READ at the source: stat the open fd, read at most
// MAX_CONTEXT_BYTES, and never allocate more. Mirrors references.ts's
// MAX_FILE_BYTES gate. The content is only ever used truncated to
// CONTEXT_SIZE_LIMIT (20,000 chars) by screenContextFile, so a 256 KB prefix
// comfortably preserves current behavior for every real context file.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Matches references.ts MAX_FILE_BYTES; comfortably > CONTEXT_SIZE_LIMIT. */
export const MAX_CONTEXT_BYTES = 256 * 1024;

/**
 * Read at most MAX_CONTEXT_BYTES from `path` as UTF-8. Allocation is bounded by
 * the cap regardless of the file's actual size. Throws (catchably) on
 * open/read errors — callers keep their existing try/catch.
 */
export function readBoundedUtf8(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const len = Math.min(fstatSync(fd).size, MAX_CONTEXT_BYTES);
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
