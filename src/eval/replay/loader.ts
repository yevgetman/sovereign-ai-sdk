// Phase 10.5 part 2b — read/write helpers for fixture JSON files.
// Stored as a single JSON object on disk (one fixture per file) for
// readability; for very long sessions an alternate JSONL-per-turn
// format would be a follow-up if file size becomes a concern.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ReplayFixture } from './types.js';

/** Read + lightly validate a fixture file. Throws on malformed JSON or
 *  schema issues (missing meta.* / turns[].providerEvents); returns the
 *  parsed fixture on success. Doesn't validate StreamEvent shapes —
 *  the runner will fail at replay time if an event is unparseable. */
export function loadReplayFixture(path: string): ReplayFixture {
  if (!existsSync(path)) {
    throw new Error(`replay fixture not found: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse fixture ${path}: ${msg}`);
  }
  return validateFixture(raw, path);
}

/** Pure: validate a parsed object against the ReplayFixture shape.
 *  Throws on the first issue with a path-rooted error message so the
 *  caller knows where to look. */
export function validateFixture(raw: unknown, source = '<inline>'): ReplayFixture {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`fixture ${source}: expected an object, got ${typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  const meta = obj.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') {
    throw new Error(`fixture ${source}: missing or non-object 'meta'`);
  }
  for (const key of ['sessionId', 'provider', 'model', 'capturedAt']) {
    if (typeof meta[key] !== 'string') {
      throw new Error(`fixture ${source}: meta.${key} must be a string`);
    }
  }
  const turns = obj.turns;
  if (!Array.isArray(turns)) {
    throw new Error(`fixture ${source}: 'turns' must be an array`);
  }
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i] as Record<string, unknown>;
    if (typeof turn?.turn !== 'number') {
      throw new Error(`fixture ${source}: turns[${i}].turn must be a number`);
    }
    if (!Array.isArray(turn.providerEvents)) {
      throw new Error(`fixture ${source}: turns[${i}].providerEvents must be an array`);
    }
    if (!Array.isArray(turn.toolResults)) {
      throw new Error(`fixture ${source}: turns[${i}].toolResults must be an array`);
    }
  }
  return raw as ReplayFixture;
}

/** Write a fixture as pretty-printed JSON. Atomic via temp + rename so
 *  a partial write can never leave a corrupt fixture on disk. */
export function writeReplayFixture(path: string, fixture: ReplayFixture): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
