// Task 8.1 — the Contract #2 SURFACE SNAPSHOT for the `src/protocol/index.ts`
// barrel (the `./protocol` subpath = "the wire types + client").
//
// The protocol module is almost entirely PURE TYPES (the SSE event union + the 6
// endpoint request/response shapes), which erase at runtime. So the runtime
// VALUE surface this snapshot pins is small and exact: `PROTOCOL_PATHS` (the
// path templates) + the 6 fetch client functions the barrel re-exports
// (createSession, postTurn, postApproval, cancel, health, streamEvents). Any
// added/removed/renamed VALUE export fails here until the list is updated on
// purpose.
//
// The TYPE half of the contract cannot be seen at runtime, so it is pinned
// SEPARATELY by the typecheck-only assertion file tests/protocol/surface.types.ts
// (a removed/renamed exported TYPE breaks `bun run typecheck`, not this test).
//
// GUARD VERIFIED (Task 8.1): temporarily adding a dummy `export const __x = 1`
// to src/protocol/index.ts (or to endpoints.ts) makes the value assertion FAIL
// (extra key); reverted.

import { describe, expect, test } from 'bun:test';
import * as protocol from '@yevgetman/sov-protocol';

/** The committed Contract #2 VALUE surface. Sorted to match
 *  `Object.keys(...).sort()` (UTF-16 order: uppercase `PROTOCOL_PATHS` precedes
 *  the lowercase client fns). Adding/removing/renaming a value export in the
 *  protocol barrel must update THIS list in the same commit. */
const EXPECTED_VALUE_EXPORTS: readonly string[] = [
  'PROTOCOL_PATHS',
  'cancel',
  'createSession',
  'health',
  'postApproval',
  'postTurn',
  'streamEvents',
];

describe('protocol barrel — Contract #2 surface snapshot', () => {
  test('the value exports equal the committed snapshot exactly', () => {
    const actual = Object.keys(protocol).sort();
    expect(actual).toEqual([...EXPECTED_VALUE_EXPORTS]);
  });

  test('PROTOCOL_PATHS + the 6 client fns are defined and the right kind', () => {
    expect(protocol.PROTOCOL_PATHS).toBeDefined();
    expect(typeof protocol.PROTOCOL_PATHS).toBe('object');
    for (const fn of [
      'cancel',
      'createSession',
      'health',
      'postApproval',
      'postTurn',
      'streamEvents',
    ]) {
      expect(typeof (protocol as Record<string, unknown>)[fn]).toBe('function');
    }
  });
});
