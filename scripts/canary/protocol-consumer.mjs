// Runtime-agnostic external consumer of @yevgetman/sov-protocol.
// Imported ONLY via the public package entry (no deep paths). Runs under
// node and bun. NO bun:test, NO import.meta.main — a plain script.
import assert from 'node:assert/strict';
import {
  PROTOCOL_PATHS,
  cancel,
  createSession,
  health,
  postApproval,
  postTurn,
  streamEvents,
} from '@yevgetman/sov-protocol';

assert.equal(typeof PROTOCOL_PATHS, 'object', 'PROTOCOL_PATHS should be an object');
for (const [label, fn] of Object.entries({ cancel, createSession, health, postApproval, postTurn, streamEvents })) {
  assert.equal(typeof fn, 'function', `${label} should be a function`);
}

console.log('PROTOCOL_OK');
