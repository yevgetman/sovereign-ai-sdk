# Phase E — Multi-User Identity + State Scoping — Design Spec

**Date:** 2026-06-06
**Status:** Draft (pre-implementation)
**Parent roadmap:** `specs/2026-06-05-run-anywhere-harness-roadmap-design.md` (Phase E / modules M4 + M5). **Depends on Phase A** (gateway auth, v0.6.18) **+ Phase D** (session supervisor, v0.6.21).

## Goal

Let **multiple distinct users share one self-hosted gateway with isolated sessions, memory, and learning** — resolving the standing `multi-user-memory-scoping` blocker (client one's first *team* conversation). A user authenticates as a **named principal**; the sessions they create are **owned** by them and invisible to others; the memory and learned instincts a turn reads/writes are **scoped to that principal**. Today the gateway is single-principal: a valid token grants full access to every session, and memory/learning are project-scoped with no user dimension.

## Scope decision (stated, not blocking)

This builds the **within-org / single-trust-domain** multi-user model: multiple *trusted-but-separate* users on one operator-run gateway, each isolated from the others' sessions + state. **Hostile cross-tenant isolation** (process/filesystem sandboxing, per-tenant resource limits, defense against a malicious tenant) is **out of scope** — that is the founder-reserved "managed multi-tenant service vs. self-hosted" decision from the roadmap, and the within-org model is **additive** to it (a managed tier would harden on top, not replace). The threat model here is *accidental cross-user access/leakage among trusted users*, not a hostile tenant.

## What exists today (verified 2026-06-06)

- **Auth is binary** — `bearerAuth(token)` (`src/server/auth.ts`) constant-time-compares one token; valid ⇒ full access. No principal is resolved or attached to the request context.
- **No session ownership** — the `sessions` row (`src/agent/sessionDb.ts`) has no owner column; every `/sessions/*` route lets any valid token read/turn/delete any session id.
- **Memory is project-only** — `$HARNESS_HOME/memory/MEMORY.md` (+ `USER.md`) and `$HARNESS_HOME/memory/projects/{projectId}/MEMORY.md`; no user dimension (`src/memory/`).
- **Learning is project-only** — `$HARNESS_HOME/learning/{projectId}/{observations.jsonl,instincts/}`; no user dimension (`src/learning/paths.ts`).
- **Config** — `gateway.token` (single string).

## Locked design decisions

| ID | Decision |
|---|---|
| **D1** | **Principals registry.** New `gateway.principals: Array<{ id, token, name? }>` config. `id` is validated as a **safe filesystem segment** (`^[A-Za-z0-9_-]+$`, non-empty, not `.`/`..`) because it becomes a path component for per-user state (defense-in-depth, mirroring `assertProfileName`). `token`s must be non-empty + unique across principals. **`principals` and the legacy `token` are mutually exclusive** (config rejects both set) — operators choose single-user (`token`) or multi-user (`principals`); cross-user *admin* roles are a noted extension, not v1. |
| **D2** | **Token → principal auth.** When `principals` is configured, the gateway auth middleware resolves the presented bearer token to a principal by **constant-time-comparing against every principal's token** (no early-exit timing leak of *which* token; a non-match of all ⇒ 401) and attaches the resolved principal to the Hono context (`c.set('principal', { id, name? })`). When the legacy single `token` (or loopback no-auth) is in effect, the request runs as the **implicit single principal** (`ownerId = null`, legacy/global state scope) — byte-compatible with today. **When `principals` IS configured, a token resolving to a principal is REQUIRED on every request — including on loopback (there is no anonymous bypass; the operator opted into multi-user).** The implicit single principal applies ONLY in legacy single-`token` / no-`principals` mode. |
| **D3** | **Session ownership.** New nullable `owner_id TEXT` column (SessionDb migration 4→5, indexed `(owner_id, last_updated DESC)`). `POST /sessions` stamps the requesting principal's `id` as `owner_id` (null for the implicit single principal). **Every `/sessions/:id/*` route + `GET /sessions` enforces ownership:** a principal may act on a session only if its `owner_id` equals the principal's id. A session owned by another principal is treated as **non-existent → 404** (existence-hiding, not 403). `GET /sessions` lists **only** the caller's own sessions. Enforced on: `GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id/messages`, `POST /sessions/:id/turns`, `GET /sessions/:id/events`, `POST /sessions/:id/approvals/*`, `DELETE /sessions/:id`. |
| **D4** | **Per-user memory scoping.** A real principal's memory lives under **`$HARNESS_HOME/users/{userId}/memory/…`** (the existing global + `projects/{projectId}` layout, nested under the user). The **implicit single principal keeps the existing top-level `$HARNESS_HOME/memory/…`** (byte-compatible). The memory path helpers + `createDefaultMemoryManager` gain an optional `userId`; `buildSessionContext` scopes the MemoryManager by the **session's `owner_id`**. `userId` is re-validated as a safe segment at the path-construction boundary (defense-in-depth). |
| **D5** | **Per-user learning scoping.** Identically, a real principal's learning corpus lives under **`$HARNESS_HOME/users/{userId}/learning/{projectId}/…`**; the implicit single principal keeps **`$HARNESS_HOME/learning/{projectId}/…`**. Observe / recall / persist (the recall loop's observations + instincts) all scope by the session's owner. Cross-user instinct promotion never crosses a user boundary. (`projectId` via `getProjectId` is unchanged and orthogonal — the userId is an outer namespace.) |
| **D6** | **Owner is the single source of truth for state scope.** Isolation is enforced at **two independent layers**: (a) **authz** — route ownership checks gate *who can touch a session*; (b) **scoping** — `buildSessionContext` derives the memory + learning namespace from the session's `owner_id`, so a turn can only ever read/write *its owner's* state. Even if an authz check were bypassed, the state read would still be the owner's, not the caller's — but both layers must hold. |
| **D7** | **Backward compatibility + gateway-scoping.** With no `principals` configured, behavior is **byte-identical to today**: implicit single principal, legacy top-level paths, no ownership enforcement. The **TUI / `sov drive` / `sov serve`** paths configure no principals → unchanged. `sov serve`'s own auth + `openai:`-namespacing are separate and untouched. The `owner_id` migration is additive (nullable; existing rows = null = implicit principal). |
| **D8** | **Security posture (hard review gate).** Per the roadmap, Phase E gets an **adversarial security review** that must clear before ship. Explicit threats: cross-user session access (authz bypass), cross-user memory/learning **leakage** (a missed scope at any read/write site, or path traversal via `userId`), token **timing** disclosure, the legacy/loopback back-compat not silently disabling enforcement when `principals` IS set, and `userId`/`projectId` path-traversal. **Negative isolation tests are first-class** (principal Q must not read/turn/delete/observe-into principal P's session or state). |

## Components

**Create:**
- `src/server/principals.ts` — the principal model + `resolvePrincipal(token, principals)` (constant-time, returns `{ id, name? } | null`) + `validatePrincipalId(id)` (safe-segment guard, shared with the path layer).
- `tests/server/principals.test.ts`, `tests/server/sessionOwnership.test.ts`, `tests/server/multiUserIsolation.test.ts` (the e2e cross-user negative suite), `tests/memory/userScope.test.ts`, `tests/learning/userScope.test.ts`.

**Modify:**
- `src/config/schema.ts` — `gateway.principals` (array) + the `principals`-XOR-`token` refinement + id/token validation.
- `src/server/auth.ts` — a principal-aware middleware variant (resolve token → principal, `c.set('principal', …)`); keep the legacy single-token path for back-compat. Mounted in `src/server/app.ts`; `startServer`/`buildAppWithRuntime` thread `principals`.
- `src/agent/sessionDb.ts` — migration 4→5 (`owner_id` + index); `createSession({ owner? })`; `getSession(id, owner?)` / `listSessions(limit, owner?)` owner filters; `deleteSession` owner-guarded (or guarded at the route).
- `src/server/routes/{sessions,turns,events,approvals}.ts` — read `principal` from context; enforce ownership (404 on mismatch); `POST /sessions` stamps owner; `GET /sessions` filters by owner.
- `src/memory/{scope.ts,bounded.ts,provider.ts}` — `userId`-aware path construction + `createDefaultMemoryManager(harnessHome, projectScope?, userId?)`.
- `src/learning/{paths.ts,instinctStore.ts}` + `src/learning-layer/` (ports + recall/observe/persist) — `userId`-aware corpus paths; thread `userId` through the recall/observe context.
- `src/server/sessionContext.ts` + `src/server/runtime.ts` — `buildSessionContext` reads the session's `owner_id` and scopes memory + learning by it; thread `userId` onto the `SessionContext` (and into `ToolContext` if a tool needs it).
- `docs/03-cli-reference/usage.md`, `docs/02-architecture/runtime-architecture.md`, `package.json`.

## Security / correctness notes

- **404, not 403**, for not-owned sessions — never disclose another principal's session existence.
- **Path-segment validation at two layers** — config-time (`validatePrincipalId`) AND path-construction-time — so a `userId` can never contain `/`, `..`, or NUL and escape its namespace, even if a future caller bypasses config.
- **Constant-time token resolution** across all principals; no early-exit that leaks which/whether a prefix matched.
- **`principals` XOR `token`** removes the admin-bypass footgun (no full-access legacy token silently coexisting with scoped principals).
- **Two-layer isolation** (authz + owner-derived scoping) — a turn physically cannot read another user's memory/learning because the namespace is derived from the session's owner, not from anything the caller supplies.
- **Implicit-principal back-compat is explicit:** enforcement engages only when `principals` is configured; single-token + loopback remain full-access-single-user by the operator's deliberate choice.
- **Known v1 limitation (flag for review):** operator-side **traces** and **fine-tune trajectories** (`$HARNESS_HOME/traces`, `…/trajectories`) are **not** per-user-partitioned in v1 — they are operator-only artifacts, never served over the API, so they are not a *turn-surfaced* cross-user leak; partitioning them is a noted follow-up. The recall loop's observations + instincts (which DO surface in a user's turns) ARE scoped.

## Out of scope (founder-reserved / later)

- Hostile cross-tenant isolation / managed-multi-tenant (process/FS sandbox, per-tenant quotas/limits) — **founder-reserved**.
- JWT / OAuth / SSO / identity providers (the token→principal registry is v1).
- Per-principal permission policies, rate limits, quotas; admin / cross-user roles; session sharing / ACLs.
- Multi-user for the TUI / `sov drive` / `sov serve` surfaces.
- Per-user partitioning of operator traces + fine-tune trajectories (noted above).
- Channels (Phase F).

## Testing + ship

TDD throughout: principal resolution + validation (unit) → ownership authz (route, incl. cross-user **negative** cases → 404) → memory + learning user-scope isolation (unit: P and Q never share a path) → an **end-to-end multi-user isolation suite** (two principals; sessions, memory, and learning each provably isolated; path-traversal `userId` rejected) → back-compat (no-principals ⇒ existing behavior unchanged; `sov drive` byte-compatible). A **hard adversarial security review** gate before ship. Full gate green. Update `docs/03-cli-reference/usage.md` (configuring principals + the multi-user model + the trust-model statement) + `docs/02-architecture/runtime-architecture.md` (the identity + scoping layer) + a state snapshot + the `CLAUDE.md`/`AGENTS.md` pointer (byte-identical; **don't touch the ACTIVE FOCUS soak banner**) + the testing-log. Commit/push; `sov upgrade`; cut a release. Per `docs/05-conventions/autonomous-feature-builds.md`, executes immediately into the plan with no approval gate.
