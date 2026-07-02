// Contract #2 conformance guard.
//
// The open protocol module (src/protocol/) is PURE TYPES — zod-free. The gateway
// keeps its zod schemas (src/server/schema.ts + src/router/progressEvents.ts) as
// the runtime validator. This file lives on the PROPRIETARY/test side (it MAY
// import zod) and proves, at TYPECHECK TIME, that the zod-inferred types and the
// hand-authored protocol types are MUTUALLY ASSIGNABLE — i.e. identical. If they
// ever diverge, `bun run typecheck` fails here. That failure IS the drift guard:
// the protocol cannot silently drift from what the gateway actually validates /
// emits. (Verified load-bearing by a deliberate field mismatch during 6.1.)
//
// The `expect(...).toBe(true)` calls are runtime no-ops — they only exist so the
// assertion sentinels are "used" (noUnusedLocals / biome noUnusedVariables). The
// real work is the type annotation on each sentinel.

import { describe, expect, test } from 'bun:test';
import type {
  CancelTurnResponse,
  CreateSessionResponse,
  DelegatorAtomCompleteEvent,
  DelegatorAtomStartedEvent,
  DelegatorCompleteEvent,
  DelegatorPlanEvent,
  HealthResponse,
  PostApprovalRequest,
  PostApprovalResponse,
  PostTurnRequest,
  PostTurnResponse,
  ServerEvent,
} from '@yevgetman/sov-protocol';
import type { z } from 'zod';
import type {
  DelegatorAtomCompleteEventSchema,
  DelegatorAtomStartedEventSchema,
  DelegatorCompleteEventSchema,
  DelegatorPlanEventSchema,
} from '../../../src/router/progressEvents.js';
import type { ServerEventSchema } from '../../../src/server/schema.js';

/** Bidirectional type-equality: resolves to `true` iff A and B are mutually
 *  assignable, otherwise `never` (so `const x: AssertEq<A, B> = true` fails to
 *  typecheck when they differ). The single-element tuple wrappers defeat
 *  distributive conditional-type behaviour over unions. */
type AssertEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// --- SSE event union (vs the live zod runtime validator) --------------------
// The genuinely load-bearing guard: ServerEventSchema is what `parseServerEvent`
// validates against at runtime, so this proves the wire protocol == reality.

const serverEventConforms: AssertEq<z.infer<typeof ServerEventSchema>, ServerEvent> = true;

const delegatorPlanConforms: AssertEq<
  z.infer<typeof DelegatorPlanEventSchema>,
  DelegatorPlanEvent
> = true;
const delegatorAtomStartedConforms: AssertEq<
  z.infer<typeof DelegatorAtomStartedEventSchema>,
  DelegatorAtomStartedEvent
> = true;
const delegatorAtomCompleteConforms: AssertEq<
  z.infer<typeof DelegatorAtomCompleteEventSchema>,
  DelegatorAtomCompleteEvent
> = true;
const delegatorCompleteConforms: AssertEq<
  z.infer<typeof DelegatorCompleteEventSchema>,
  DelegatorCompleteEvent
> = true;

// --- Endpoint request/response shapes (vs the recorded handler shapes) ------
// The 6 Contract-#2 endpoints have no zod schemas (inline casts / literal
// returns), so each protocol type is pinned against the handler's recorded
// shape, cited to the exact line. Task 6.2 wires the handlers to these types for
// runtime-level enforcement; until then this catches protocol-vs-handler drift.

// POST /sessions — sessions.ts:86 returns { sessionId, createdAt: new Date().toISOString() }.
type CreateSessionResponseRecorded = { sessionId: string; createdAt: string };
const createSessionRespConforms: AssertEq<CreateSessionResponseRecorded, CreateSessionResponse> =
  true;

// POST /sessions/:id/turns — turns.ts:177 body cast { text?: string; kind?: string };
// turns.ts:291 returns { accepted: true }.
type PostTurnRequestRecorded = { text?: string; kind?: string };
type PostTurnResponseRecorded = { accepted: boolean };
const postTurnReqConforms: AssertEq<PostTurnRequestRecorded, PostTurnRequest> = true;
const postTurnRespConforms: AssertEq<PostTurnResponseRecorded, PostTurnResponse> = true;

// POST /sessions/:id/approvals/:requestId — approvals.ts:55+70+77 validate
// { approved: boolean; always?: boolean; updatedInput?: unknown }; :85 returns { ok: true }.
type PostApprovalRequestRecorded = {
  approved: boolean;
  always?: boolean;
  updatedInput?: unknown;
};
type PostApprovalResponseRecorded = { ok: boolean };
const postApprovalReqConforms: AssertEq<PostApprovalRequestRecorded, PostApprovalRequest> = true;
const postApprovalRespConforms: AssertEq<PostApprovalResponseRecorded, PostApprovalResponse> = true;

// POST /sessions/:id/cancel — cancel.ts:51 returns { cancelled } (boolean).
type CancelTurnResponseRecorded = { cancelled: boolean };
const cancelRespConforms: AssertEq<CancelTurnResponseRecorded, CancelTurnResponse> = true;

// GET /health — health.ts:11 returns { ok: true, version: VERSION } (VERSION: string).
type HealthResponseRecorded = { ok: boolean; version: string };
const healthRespConforms: AssertEq<HealthResponseRecorded, HealthResponse> = true;

describe('protocol conformance (Contract #2)', () => {
  test('ServerEvent union is identical to the gateway zod schema', () => {
    expect(serverEventConforms).toBe(true);
    expect(delegatorPlanConforms).toBe(true);
    expect(delegatorAtomStartedConforms).toBe(true);
    expect(delegatorAtomCompleteConforms).toBe(true);
    expect(delegatorCompleteConforms).toBe(true);
  });

  test('endpoint request/response types match the handler shapes', () => {
    expect(createSessionRespConforms).toBe(true);
    expect(postTurnReqConforms).toBe(true);
    expect(postTurnRespConforms).toBe(true);
    expect(postApprovalReqConforms).toBe(true);
    expect(postApprovalRespConforms).toBe(true);
    expect(cancelRespConforms).toBe(true);
    expect(healthRespConforms).toBe(true);
  });
});
