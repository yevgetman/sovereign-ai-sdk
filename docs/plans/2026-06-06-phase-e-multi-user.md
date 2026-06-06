# Phase E — Multi-User Identity + State Scoping · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Checkbox steps. Executes per `docs/conventions/autonomous-feature-builds.md` — no approval gates. Read the cited files first to match exact current signatures, then TDD (red → green → commit). **Security-critical phase — negative isolation tests are mandatory, not optional.**

**Goal:** Multiple distinct users share one self-hosted gateway with isolated sessions, memory, and learning, per `docs/specs/2026-06-06-phase-e-multi-user-design.md`.

**Architecture:** A `gateway.principals` registry maps bearer tokens → named principals. Auth resolves the token to a principal and attaches it to the request context. Sessions carry an `owner_id`; routes enforce owner-only access (404 on mismatch). Memory + learning paths gain a `userId` namespace derived from the session's owner, so a turn can only ever read/write its owner's state. No `principals` ⇒ byte-identical single-user behavior (TUI/drive/serve untouched).

**Tech Stack:** TypeScript on Bun, Hono, Zod, `bun:test`, MockProvider.

---

## Investigation findings (verified — cite while implementing)

- **Auth** (`src/server/auth.ts:1-41`): `bearerAuth(token)` constant-time `timingSafeEqual` (`:16`); no principal attached. Mounted `src/server/app.ts:75-77` (`app.use('/sessions/*', bearerAuth(opts.auth))`), after CORS (`:60`) + open `/health`/`/`/`/ui`. `startServer` (`src/server/index.ts:37`) + `buildAppWithRuntime` thread `auth`.
- **Sessions schema** (`src/agent/sessionDb.ts:52-64`): no owner column. `CURRENT_SCHEMA_VERSION = 4`; migrations array `:43-145` (pattern: `ALTER TABLE sessions ADD COLUMN …` + version bump). `createSession` (`:474-503`), `getSession(id)` (`:601-616`), `listSessions(limit=20)` (`:566-585`), `deleteSession(id)` (Phase D). `Session` type `:202-222`; `CreateSessionInput` `:162-178`.
- **Routes** (`src/server/routes/`): `sessions.ts` POST `:52-77` / GET-list `:79-104` / GET-:id `:106-117` / messages `:119-128` / DELETE `:130-143`; `turns.ts` POST `:97`; `events.ts` GET `:52`; `approvals.ts`. **No ownership checks anywhere today.**
- **Memory** (`src/memory/`): `scope.ts` `resolveProjectScope` (`:33-68`) → `ProjectScope` (`:23`); `bounded.ts` global paths `:44-46`, project paths `:94-96`; `provider.ts` `BuiltinMarkdownMemoryProvider` (`:39-76`) + `createDefaultMemoryManager(harnessHome, projectScope?)` (`:144-151`). Wired in `src/server/sessionContext.ts:~250-280` (build) via `resolveProjectScope` + `createDefaultMemoryManager`.
- **Learning** (`src/learning/`): `paths.ts` (`:7-35` — `learningRoot`/`projectRoot`/`observationsPath`/`instinctsDir`/`instinctPath`, `GLOBAL_PROJECT_ID='_global'`); `project.ts` `getProjectId(cwd)` (`:13-37`); `instinctStore.ts` (`:18-65`); `src/learning-layer/index.ts` `recall` (`:12-25`, reads `ctx.projectId`). Recall wired in `sessionContext.ts` (sets `recall`), injected in `turns.ts`.
- **SessionContext** (`src/server/sessionContext.ts:58-107`): per-session; holds `memoryManager`, `projectScope`, `recall`. Built lazily via `runtime.getSessionContext` (`runtime.ts:~1212-1219`).
- **Config** (`src/config/schema.ts:417-443`): the `gateway` block. Credential-list precedents: `CredentialConfigSchema` (`:8-15`), `taskRouting` lanes (map, `:183-189`). Profile-name validator precedent: `assertProfileName` (`src/config/paths.ts`).

## File structure
**Create:** `src/server/principals.ts`; `tests/server/principals.test.ts`, `tests/server/sessionOwnership.test.ts`, `tests/server/multiUserIsolation.test.ts`, `tests/memory/userScope.test.ts`, `tests/learning/userScope.test.ts`.
**Modify:** `src/config/schema.ts`, `src/server/auth.ts`, `src/server/app.ts`, `src/server/index.ts`, `src/cli/gatewayCommand.ts`, `src/agent/sessionDb.ts`, `src/server/routes/{sessions,turns,events,approvals}.ts`, `src/memory/{scope.ts,bounded.ts,provider.ts}`, `src/learning/{paths.ts,instinctStore.ts}`, `src/learning-layer/` (ports + recall/observe/persist), `src/server/sessionContext.ts`, `docs/usage.md`, `docs/architecture.md`, `package.json`.

## Conventions (every task)
`.js` import specifiers; no mutation; `bun:test`; explicit types; `unknown`+narrow; **404 (not 403) for not-owned**; **constant-time token compare**; **validate every `userId` as `^[A-Za-z0-9_-]+$` at the path boundary**; preserve all single-user/back-compat behavior (no `principals` ⇒ unchanged). Pre-commit gate (`bun run lint && bun run typecheck && bun run test`, baseline ~2861/0/14, no new failures). Atomic commits. **NO release until E-T9.**

---

## E-T1 — config principals + the principal resolver (~25 min · Opus)
**Files:** `src/config/schema.ts`; create `src/server/principals.ts` + `tests/server/principals.test.ts`; extend `tests/config/schema.test.ts`.
- [ ] **Failing tests:**
  - schema: `gateway.principals: [{ id:'alice', token:'tok-a' }, { id:'bob', token:'tok-b', name:'Bob' }]` parses; **rejects** `principals` AND `token` both set; rejects duplicate ids; rejects duplicate tokens; rejects empty/`..`/`a/b` ids; absent `principals` valid.
  - `principals.ts`: `validatePrincipalId('alice')` ok; `validatePrincipalId('../x' | '' | 'a/b' | '.')` throws. `resolvePrincipal('tok-b', principals)` → `{ id:'bob', name:'Bob' }`; unknown token → `null`; compares against ALL principals (constant-time; assert no early-exit by checking it still resolves a last-position principal).
- [ ] Red.
- [ ] **Implement:** `src/server/principals.ts` — `export interface Principal { id: string; name?: string }`; `validatePrincipalId(id): void` (regex `^[A-Za-z0-9_-]+$`, non-empty, not `.`/`..`); `resolvePrincipal(token, principals): Principal | null` (iterate all, constant-time-compare each token via the same `timingSafeEqual` shape as `auth.ts`, return the match). In `schema.ts` add `principals: z.array(z.object({ id: z.string(), token: z.string().min(1), name: z.string().optional() })).optional()` to the `gateway` block, with a `.superRefine` (or `.refine`) enforcing: not-both-with-`token`, unique ids, unique tokens, each id matches the safe-segment regex.
- [ ] Green; gate. Commit `feat(gateway): principals registry config + token→principal resolver`.

## E-T2 — principal-aware auth middleware (~25 min · Opus)
**Files:** `src/server/auth.ts`, `src/server/app.ts`, `src/server/index.ts`, `src/cli/gatewayCommand.ts`; tests in `tests/server/auth.test.ts` (extend).
- [ ] **Failing tests** (via `buildAppWithRuntime` + `app.request`):
  - principals mode: a request to `/sessions` with `Authorization: Bearer tok-a` passes and the resolved principal is available to routes (assert via a route behavior in E-T4, or here assert 200 vs 401); no token → 401; wrong token → 401; **loopback/no-token still 401 when principals configured** (no anonymous bypass).
  - legacy single-`token` mode: unchanged (valid token 200, bad 401).
  - no-auth (no token, no principals): open as today.
- [ ] Red.
- [ ] **Implement:** add a `principalAuth(principals)` middleware (resolve `Bearer` token via `resolvePrincipal`; null → 401; else `c.set('principal', principal)` and `next()`). In `app.ts`, when `opts.principals` is set, mount `principalAuth(opts.principals)` on `/sessions/*` (instead of the single-token `bearerAuth`); when only `opts.auth` is set, keep `bearerAuth`; thread `principals?` through `buildAppWithRuntime` opts + `startServer` (`index.ts`) + `runGateway` (`gatewayCommand.ts`, reading `config.gateway?.principals`). Define a shared context type for `c.get('principal')` (e.g. `c.set('principal', …)` with a `Variables` generic, or a small typed getter helper). Routes that run under no-principals mode see `principal === undefined` ⇒ implicit single principal.
- [ ] Green; gate (existing auth/cors/gateway tests unchanged in single-token mode). Commit `feat(gateway): principal-aware auth middleware (token→principal, no anonymous bypass when configured)`.

## E-T3 — SessionDb owner_id (migration + owner-aware queries) (~25 min · Opus)
**Files:** `src/agent/sessionDb.ts`; `tests/agent/sessionDbOwner.test.ts` (new) + extend existing sessionDb tests.
- [ ] **Failing tests:** migration 4→5 adds `owner_id` (existing rows null); `createSession({ owner:'alice', … })` persists it, `getSession(id).ownerId === 'alice'`; `getSession(id, 'bob')` → null (owner filter); `listSessions(20, 'alice')` returns only alice's; `listSessions(20)` (no owner) returns all (back-compat); a session created with no owner has `ownerId === null` and is returned by the unfiltered queries.
- [ ] Red.
- [ ] **Implement:** add `{ from:4, to:5, sql: 'ALTER TABLE sessions ADD COLUMN owner_id TEXT; CREATE INDEX idx_sessions_owner ON sessions(owner_id, last_updated DESC);' }` to `MIGRATIONS`; bump `CURRENT_SCHEMA_VERSION = 5`. Add `owner?: string` to `CreateSessionInput`, `ownerId: string | null` to `Session` + `SessionListEntry`, and to `rowToSession`/`rowToListEntry`. `createSession` writes `input.owner ?? null`. Add optional `owner?: string` to `getSession`/`listSessions` → when provided, add `AND owner_id = ?` / `WHERE owner_id = ?`. Keep all existing call sites working (owner optional).
- [ ] Green; gate. Commit `feat(sessions): owner_id column + owner-scoped getSession/listSessions`.

## E-T4 — route ownership enforcement (~30 min · Opus)
**Files:** `src/server/routes/{sessions,turns,events,approvals}.ts`; create `tests/server/sessionOwnership.test.ts`.
A small shared helper: `requirePrincipalId(c): string | null` returns `c.get('principal')?.id ?? null` (null = implicit single principal). A second helper `assertOwned(runtime, sessionId, ownerId): Session | null` returns the session iff `ownerId === null` (implicit/legacy — no enforcement) OR `session.ownerId === ownerId`, else null (→ route returns 404).
- [ ] **Failing tests** (principals mode, two principals alice/bob, MockProvider):
  - `POST /sessions` as alice stamps `owner_id='alice'` (verify via `getSession`).
  - `GET /sessions` as alice lists only alice's sessions (bob's absent).
  - cross-user **negative** (the security core): bob → `GET /sessions/:aliceId`, `GET …/messages`, `POST …/turns`, `GET …/events`, `POST …/approvals/:rid`, `DELETE …/:aliceId` ALL return **404**.
  - alice can do all of the above on her own session (200/202/204).
  - back-compat: no-principals mode → no enforcement (owner null; any access works as today).
- [ ] Red.
- [ ] **Implement:** in each route, read `ownerId = c.get('principal')?.id ?? null`; on session-scoped routes, fetch the session (`getSession(id)` — or `getSession(id, ownerId)` when ownerId non-null) and return 404 if it doesn't exist OR (ownerId !== null AND session.ownerId !== ownerId). `POST /sessions` passes `owner: ownerId ?? undefined` to `createSession`. `GET /sessions` passes `ownerId ?? undefined` to `listSessions`. Keep the 404-before-any-side-effect ordering (esp. DELETE/turns). For events/turns (which may already getOrCreate a bus / context), do the ownership check BEFORE creating any per-session state.
- [ ] Green; gate (existing single-token route tests unchanged — ownerId null path). Commit `feat(gateway): owner-only session access across all /sessions routes (404 on mismatch)`.

## E-T5 — per-user memory scoping (~30 min · Opus)
**Files:** `src/memory/{scope.ts,bounded.ts,provider.ts}`, `src/server/sessionContext.ts`; create `tests/memory/userScope.test.ts`.
- [ ] **Failing tests:** memory path helpers with `userId='alice'` resolve under `…/users/alice/memory/…`; with `userId` undefined/null resolve to the EXISTING top-level `…/memory/…` (back-compat, byte-identical paths); a malicious `userId` (`'../x'`, `'a/b'`) throws at the path boundary; `createDefaultMemoryManager(home, scope, 'alice')` reads/writes alice's namespace and `…(home, scope)` (no userId) reads the legacy namespace; alice's and bob's `MEMORY.md` are different files.
- [ ] Red.
- [ ] **Implement:** thread an optional `userId` through the memory path builders in `bounded.ts` (global + project paths gain a `users/{userId}/` prefix when `userId` is set; **call `validatePrincipalId(userId)` before using it in a path**) and `BuiltinMarkdownMemoryProvider` + `createDefaultMemoryManager(harnessHome, projectScope?, userId?)`. In `sessionContext.ts` `buildSessionContext`, read the session's `ownerId` (`runtime.sessionDb.getSession(sessionId)?.ownerId ?? null`) and pass it as the `userId` to `createDefaultMemoryManager` (null → legacy path). Import `validatePrincipalId` from `principals.ts` (or a shared util) for the boundary check.
- [ ] Green; gate. Commit `feat(memory): per-user memory namespace (users/{id}/…); legacy path unchanged`.

## E-T6 — per-user learning scoping (~30 min · Opus)
**Files:** `src/learning/{paths.ts,instinctStore.ts}`, `src/learning-layer/` (ports + recall/observe/persist), `src/server/sessionContext.ts`; create `tests/learning/userScope.test.ts`.
- [ ] **Failing tests:** learning path helpers with `userId='alice'` resolve under `…/users/alice/learning/{projectId}/…`; with no `userId` → existing `…/learning/{projectId}/…` (back-compat); malicious `userId` throws; alice's observations/instincts and bob's are different files; recall for alice reads only alice's instincts.
- [ ] Red.
- [ ] **Implement:** thread an optional `userId` through the learning path builders in `paths.ts` (prefix `users/{userId}/` when set; validate the segment), `instinctStore.ts` (list/read/write under the user namespace), and the learning-layer recall/observe/persist context (add `userId?` to the recall/observe context type alongside `projectId`; the FS adapter uses it in the path). In `buildSessionContext`, pass the session's `ownerId` as the `userId` to the recall/observe wiring (null → legacy). Keep `getProjectId` unchanged (userId is an outer namespace).
- [ ] Green; gate. Commit `feat(learning): per-user learning corpus namespace; legacy path unchanged`.

## E-T7 — end-to-end multi-user isolation suite (~25 min · Opus)
**Files:** create `tests/server/multiUserIsolation.test.ts`.
- [ ] Drive the REAL app (`buildAppWithRuntime` with `principals:[alice,bob]`, MockProvider) and assert, end-to-end:
  - alice creates a session + runs a turn; bob CANNOT see/turn/delete it (404 across all routes); `GET /sessions` is per-owner.
  - **memory isolation:** after alice's turn writes/reads memory, bob's session in the same project reads a DIFFERENT (empty/own) memory namespace — assert the on-disk paths differ and bob never sees alice's content.
  - **learning isolation:** alice's observations/instincts land under alice's namespace; bob's recall never returns alice's instincts.
  - **path traversal:** a principal id like `../evil` is rejected at config load (or, if it somehow reached a path, the boundary validator throws) — assert the validator rejects it.
  - **back-compat:** no-principals mode → single-user behavior unchanged (one session visible, legacy memory/learning paths).
- [ ] Green; gate. Commit `test(gateway): end-to-end multi-user isolation (sessions + memory + learning)`.

## E-T8 — adversarial security review + fixes (HARD GATE) (~ review dispatch + fixes · Opus)
- [ ] Dispatch an adversarial security reviewer over the whole Phase E surface (auth, ownership, memory + learning scoping, the back-compat paths). Threats: cross-user session access; cross-user memory/learning leakage (any unscoped read/write; path traversal via userId/projectId); token timing; the no-principals/loopback path not silently disabling enforcement when principals IS set; 403-vs-404 disclosure; the `principals`-XOR-`token` refinement actually firing. Must reach **SECURE-TO-SHIP** (no Critical/High).
- [ ] Fix every Critical/High (and cheap Medium) it finds; re-review if needed. Gate green.
- [ ] Commit fixes atomically.

## E-T9 — docs + close-out + release (~25 min · Opus)
**Files:** `docs/usage.md`, `docs/architecture.md`, `docs/testing-log.md`, `docs/state/2026-06-06-phase-e-multi-user.md`, roadmap spec (mark Phase E shipped), `CLAUDE.md`+`AGENTS.md` (state pointer; **DON'T touch the soak banner**; `diff` empty), `package.json`.
- [ ] `docs/usage.md`: "Multi-user gateway" — configure `gateway.principals` (id/token/name; XOR the single `token`), the trust model (within-org; not hostile-multi-tenant), owner-only sessions, per-user memory + learning, the no-anonymous-bypass rule. Curl examples with two principals.
- [ ] `docs/architecture.md`: the identity + per-user scoping layer (token→principal, owner_id, owner-derived memory/learning namespace; two-layer isolation).
- [ ] State snapshot `docs/state/2026-06-06-phase-e-multi-user.md` (match recent style): what shipped, the within-org scope + founder-reserved managed-tenant line, the two-layer isolation, the security-review verdict, the known v1 limitation (traces/trajectories not per-user-partitioned), test count, version (v0.6.22), roadmap (A–E shipped; **F channels remains**), learning soak continues.
- [ ] Update the state pointer in `CLAUDE.md`+`AGENTS.md` (boot item 3 + Current-state table); **leave the ACTIVE FOCUS soak banner untouched**; `diff CLAUDE.md AGENTS.md` empty (`cp`).
- [ ] Testing-log entry. Mark Phase E `✅ Shipped v0.6.22 (2026-06-06)` in the roadmap spec (leave F).
- [ ] **Release** per `docs/conventions/cutting-releases.md`: 0.6.21 → **0.6.22**; push master; bump `package.json` + release commit; push; `sov-releases/CHANGELOG.md` 0.6.22 entry (user-facing: "Multi-user gateway: configure named principals — each gets isolated sessions, memory, and learning"); tag `v0.6.22`; CI → success; `gh release view`; `sov upgrade`; **post-upgrade smoke** (boot the upgraded gateway with two principals; alice's token can't read a session created by bob's token → 404; verify `~/.sov/bin/sov --version` → 0.6.22). Commit + push.

---

## Self-review
**Spec coverage:** D1 principals+XOR+id-validation → E-T1; D2 token→principal auth + no-anon-bypass → E-T2; D3 owner_id + ownership routes → E-T3 (column) + E-T4 (enforcement); D4 memory scope → E-T5; D5 learning scope → E-T6; D6 two-layer (authz + owner-derived scope) → E-T4 + E-T5/T6 (buildSessionContext uses owner_id); D7 back-compat → every task's no-principals/null-owner path + E-T7; D8 security review + negative tests → E-T7 + E-T8. Every decision maps to a task.
**Placeholder scan:** none — concrete files, tests, signatures, path layouts.
**Type/name consistency:** `Principal{id,name?}`, `resolvePrincipal`, `validatePrincipalId`, `gateway.principals`, `owner_id`/`ownerId`, `c.get('principal')`, `createDefaultMemoryManager(home, scope?, userId?)`, `users/{userId}/…` — consistent across E-T1…E-T9. Load-bearing security points called out: 404-not-403, constant-time resolve, userId path-validation at the boundary, no-anonymous-bypass-when-principals-set, owner-derived (not caller-supplied) state namespace.

## Execution
Per the autonomous convention: E-T1→E-T9 subagent-driven (fresh Opus implementer per task + spec + code-quality review; **E-T8 is a hard adversarial security gate**), no approval gates; ship (release v0.6.22) at E-T9. The learning-loop soak continues untouched in parallel.
