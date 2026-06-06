// Phase E T4 — owner-only session access: the single ownership chokepoint.
//
// The gateway is multi-user. Once a request's bearer token resolves to a real
// principal (principals mode), that principal may act on a session ONLY if it
// owns it. Any other session (owned by someone else, or unowned) is treated as
// NON-EXISTENT → callers 404 (existence-hiding; NEVER 403, never reveal that
// another principal's session exists).
//
// The implicit owner (null) is the single-principal / legacy single-token /
// open mode: NO enforcement (back-compat — behaves exactly as before Phase E).
//
// Every per-session route funnels its session lookup through here so the
// ownership rule lives in ONE place and can't drift between routes. The check
// MUST run BEFORE any side effect or per-session state creation (bus creation,
// context build, turn start, teardown) — call this at the top of the handler
// and 404 on null.

import type { Context } from 'hono';
import type { Session } from '../../agent/sessionDb.js';
import { type AppVariables, getPrincipal } from '../auth.js';
import type { Runtime } from '../runtime.js';

/** The request's owner id: the resolved principal's id, or `null` for the
 *  implicit single-principal / legacy single-token / open mode. `null` means
 *  NO per-principal enforcement (back-compat). */
export function ownerIdOf(c: Context<{ Variables: AppVariables }>): string | null {
  return getPrincipal(c)?.id ?? null;
}

/** Load a session the request is allowed to act on, or `null` when it must be
 *  treated as non-existent (so callers 404).
 *
 *  - implicit owner (null): returns the row regardless of ownership — the
 *    single-user / legacy / open back-compat path, byte-identical to a bare
 *    `getSession`.
 *  - real principal: returns the row only if `session.ownerId === owner`. A
 *    session owned by someone else, or an unowned session, is hidden as
 *    non-existent (null) — never disclosed, never 403.
 *
 *  Does not 404 here — it returns null and lets each route emit its existing
 *  not-found 404 so malformed-id 400 + not-found 404 behavior stays intact. */
export function loadOwnedSession(
  runtime: Runtime,
  c: Context<{ Variables: AppVariables }>,
  sessionId: string,
): Session | null {
  const owner = ownerIdOf(c);
  const session = runtime.sessionDb.getSession(sessionId);
  if (session === null) return null;
  if (owner !== null && session.ownerId !== owner) return null;
  return session;
}
