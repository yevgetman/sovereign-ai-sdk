# State of the build — Phase E: Multi-user identity + state scoping (shipped; named principals with isolated sessions, memory, and learning, served by the gateway)

**HEAD:** the `chore(release): bump version 0.6.21 -> 0.6.22` commit (the Phase E multi-user run). **Release:** **v0.6.22** (2026-06-06).

**Predecessor:** [`docs/07-history/state/2026-06-06-phase-d-supervisor.md`](2026-06-06-phase-d-supervisor.md) (Phase D — Persistent multi-session supervisor shipped; idle eviction + session lifecycle; v0.6.21).

## What this snapshot is

The **fifth phase (Phase E / modules M4 + M5) of the run-anywhere, persistent, multi-channel harness roadmap** — a real phase, not a hardening run. It makes the long-lived `sov gateway` **multi-user**: multiple distinct, named users share one self-hosted gateway with **isolated sessions, memory, and learning**. A user authenticates as a *principal*; the sessions they create are *owned* by them and invisible to others; the memory and learned instincts a turn reads/writes are scoped to that principal. It resolves the standing `multi-user-memory-scoping` blocker (a client's first *team* conversation). Before Phase E the gateway was single-principal: any valid token granted full access to every session, and memory/learning were project-scoped with no user dimension.

Authoritative implementation docs in this repo:
- **Roadmap:** [`specs/2026-06-05-run-anywhere-harness-roadmap-design.md`](specs/2026-06-05-run-anywhere-harness-roadmap-design.md) (the program; A–F; A + B + C + D + E now marked shipped)
- **Spec:** [`specs/2026-06-06-phase-e-multi-user-design.md`](specs/2026-06-06-phase-e-multi-user-design.md) (D1–D8)
- **Plan:** [`plans/2026-06-06-phase-e-multi-user.md`](plans/2026-06-06-phase-e-multi-user.md) (E-T1…E-T9)

The roadmap + decision record (ADR H-0010, the multi-channel-gateway differentiator) stay canonical in `~/code/sovereign-ai-docs`; this repo owns the code and the implementation docs. **No new ADRs in this repo** — Phase E is additive + gateway-scoped (a principals registry, principal-aware auth, an `owner_id` column + route ownership chokepoint, and an owner-derived per-user memory/learning namespace), all decisions captured in the spec + commit messages. The default `sov` (TUI) / `sov serve` / `sov drive` surfaces are byte-unchanged: they configure no principals, so the `owner_id` is null, ownership enforcement is off, and memory/learning use the existing top-level paths.

## Where this sits in the roadmap

Phase E is **piece 5 of 6**. The roadmap is dependency-ordered:

```
A ──> B ──> C            (browser UI on a secure, robust transport)
 \     \
  \     └─> D ──> E ──> F   (persistent supervisor → multi-user → channels)
   └────────> D
```

- A — Secure remote gateway (M1) — ✅ shipped (v0.6.17 + v0.6.18 hardening).
- B — Multi-client session transport (M2) — ✅ shipped (v0.6.19).
- C — Reference web UI (M8) — ✅ shipped (v0.6.20).
- D — Persistent multi-session supervisor / service install (M3) — ✅ shipped (v0.6.21).
- **E — Multi-user identity + state scoping (M4 + M5, security-reviewed) — ✅ shipped (this snapshot, v0.6.22).**
- F — Channel framework + Slack/Telegram/webhook adapters. **Remaining.**

Each phase is independently shippable; the program can pause after any phase with a coherent released increment. A→B→C delivered the first complete "run-anywhere from a browser" arc; D made that gateway a persistent always-on backbone; **E makes it multi-user** — isolated per-user sessions + state on one host. Only **F (channels)** remains.

## Scope decision — within-org / single-trust-domain (the founder-reserved managed-tenant line stays drawn)

Phase E builds the **within-org / single-trust-domain** multi-user model: multiple *trusted-but-separate* users on one operator-run gateway (a team, a household, a small org), isolated from each other's sessions + state. The threat it addresses is **accidental cross-user access or leakage among trusted users**.

**Hostile cross-tenant isolation is OUT (founder-reserved)** — process/filesystem sandboxing, per-tenant resource limits, defense against a *malicious* tenant. That is the roadmap's founder-reserved "managed multi-tenant service vs. self-hosted-only" decision; the within-org model is **additive** to it (a managed tier would harden on top, not replace). Every principal still wields the harness's full tool powers under the configured permission policy, on the same host — the gateway is not a sandbox.

## What shipped (Phase E)

1. **Principals registry + token→principal resolver (E-T1; `src/server/principals.ts`, `src/config/schema.ts`).** New `gateway.principals: Array<{ id, token, name? }>` config. Each `id` is validated as a **safe filesystem segment** (`^[A-Za-z0-9_-]+$`, non-empty, not `.`/`..`) because it becomes a path component for per-user state (mirrors `assertProfileName`); `token`s must be non-empty + unique. **`principals` and the legacy single `gateway.token` are mutually exclusive** — the schema refinement rejects both being set (removes the admin-bypass footgun of a full-access token coexisting with scoped principals). `resolvePrincipal(token, principals)` constant-time-compares the presented token against **every** principal's token (no early-exit that leaks which/whether a token matched) and returns `{ id, name? } | null`. `validatePrincipalId(id)` is shared with the path layer.

2. **Principal-aware auth middleware (E-T2; `src/server/auth.ts`, `app.ts`, `index.ts`, `gatewayCommand.ts`).** When `principals` is configured, a `principalAuth(principals)` middleware mounts on `/sessions/*` (incl. the SSE stream): it resolves the bearer token to a principal, returns 401 on no match, and attaches the resolved principal to the Hono context (`c.set('principal', …)`). **No anonymous bypass:** in principals mode a resolving token is **required on every request, including on loopback** — the operator deliberately opted into multi-user. The legacy single-`token` path and the loopback no-auth path are unchanged and run as the **implicit single principal** (`ownerId = null`, legacy/global state scope). `buildAppWithRuntime` / `startServer` / `runGateway` thread `principals?` (read from `config.gateway?.principals`).

3. **Session ownership column + owner-scoped queries (E-T3; `src/agent/sessionDb.ts`).** A nullable `owner_id TEXT` column via **SessionDb migration 4→5** (indexed `(owner_id, last_updated DESC)`), `CURRENT_SCHEMA_VERSION` 4→5. `createSession({ owner? })` persists it; `getSession(id, owner?)` and `listSessions(limit, owner?)` gain optional owner filters (`AND owner_id = ?` / `WHERE owner_id = ?`); `Session` + `SessionListEntry` carry `ownerId: string | null`. The migration is additive — existing rows = null = implicit principal; the unfiltered queries still return everything (back-compat).

4. **Route ownership enforcement — the keystone authz chokepoint (E-T4; `src/server/routes/{sessions,turns,events,approvals}.ts`).** `POST /sessions` stamps the requesting principal's id as `owner_id`. **Every `/sessions/:id/*` route returns 404 — not 403 — when the caller isn't the owner** (existence-hiding: another user's session is indistinguishable from a nonexistent one). The chokepoint covers **messages, turns, events, approvals, cancel, compact, commands, skills, and DELETE**; the ownership check runs **before** any per-session state (bus / context) is created. `GET /sessions` lists only the caller's own sessions. Helpers: `ownerId = c.get('principal')?.id ?? null` (null = implicit single principal → no enforcement, legacy behavior). Also the **E-T4 tightening:** the events/approvals routes now require the session to **exist in the DB** (previously they would attach to / create a bus for an unknown id).

5. **Per-user memory scoping (E-T5; `src/memory/{scope,bounded,provider}.ts`, `src/server/sessionContext.ts`).** A real principal's memory lives under **`$HARNESS_HOME/users/{userId}/memory/…`** (the existing global + `projects/{projectId}` layout, nested under the user). The memory path helpers + `createDefaultMemoryManager(harnessHome, projectScope?, userId?)` gained an optional `userId`; `buildSessionContext` derives it from the **session's `owner_id`** (never caller input) and re-validates it as a safe segment at the path-construction boundary. The **implicit single principal keeps the existing top-level `$HARNESS_HOME/memory/…`** (byte-identical).

6. **Per-user learning scoping (E-T6; `src/learning/{paths,instinctStore}.ts`, `src/learning-layer/`, `src/server/sessionContext.ts`).** Identically, a real principal's learning corpus lives under **`$HARNESS_HOME/users/{userId}/learning/{projectId}/…`**; observe / recall / persist all scope by the session's owner, so instinct promotion never crosses a user boundary. The implicit single principal keeps **`$HARNESS_HOME/learning/{projectId}/…`**. `getProjectId` is unchanged and orthogonal — the `userId` is an outer namespace.

7. **End-to-end multi-user isolation suite (E-T7; `tests/server/multiUserIsolation.test.ts`).** Drives the real `buildAppWithRuntime` (`principals: [alice, bob]`, MockProvider) and asserts end-to-end: alice's session is invisible to bob across **every** route (404); `GET /sessions` is per-owner; alice's and bob's memory + learning land in different on-disk namespaces and never cross; a `../evil`-style principal id is rejected at the validator. Plus per-area negative suites: `tests/server/principals.test.ts`, `tests/server/sessionOwnership.test.ts`, `tests/memory/userScope.test.ts`, `tests/learning/userScope.test.ts`.

## Two-layer isolation (the core invariant)

Isolation is enforced at **two independent layers**, and **both must hold** (defense-in-depth, spec D6):

- **(a) Authz** — the route ownership checks (E-T4) gate *who can touch a session* (404 on mismatch).
- **(b) Owner-derived scoping** — `buildSessionContext` derives the memory + learning namespace from the **session's `owner_id`**, never from anything the caller supplies. So even if an authz check were bypassed, a turn could only ever read/write *its owner's* state, not the caller's.

A separate first layer of path-segment validation (`validatePrincipalId`) runs **at config-load AND at path-construction time**, so a `userId` can never contain `/`, `..`, or NUL and escape its namespace even if a future caller bypassed config.

## The adversarial security review — SECURE-TO-SHIP (found + fixed 2 cross-user leaks)

Per the roadmap's hard gate (X1; spec D8), Phase E got an **adversarial security review** over the whole surface (auth, ownership, memory + learning scoping, the back-compat paths). It **found two real cross-user isolation leaks**, both where per-turn code dropped the principal id and fell back to the *shared* legacy `$HARNESS_HOME/memory|learning` store. Both were fixed (RED-before / GREEN-after) in `d7559a8` before ship:

- **C1 (Critical) — the `memory` tool ignored the user scope.** The default-registry `memory` tool (reachable on the gateway + from sub-agents) called the bounded-memory path helpers **without** the trailing `userId` arg, so every user's tool reads/writes hit the shared legacy files — a cross-user memory leak. Fix: thread `ctx.userId` through `handleView` + `handleReplace` to all five helper call sites (`readAllMemory` / `readMemoryFile` / `readProjectMemoryFile` / `replaceMemoryFile` / `replaceProjectMemoryFile`). Undefined `userId` keeps the legacy path (back-compat). Test: `tests/tools/memoryToolUserScope.test.ts`.
- **H1 (High) — the compaction child dropped the owner.** `compactSession` copied model/provider/platform/parent/systemPrompt/metadata/title onto the compaction child but **not** `owner`, so after a compaction pivot `turns.ts` (`getSessionContext(childId)`) rebuilt context with `ownerId = null` → the legacy namespace for the rest of the turn. Fix: carry `parent.ownerId` onto the child `createSession`; defense-in-depth, the scheduler's `createChildSession` closure now stamps the child with the parent session's owner too, so any future `getSessionContext(childId)` is correctly scoped. Both omit `owner` when the parent is unowned (byte-identical to before). Test: `tests/compact/compactOwner.test.ts`.

A sweep for sibling C1-class bugs found **none** — the memory provider, learning observer, instinct tools, and the injected-prefetch path all already thread the principal id; the eval harnesses + admin CLI are out of the per-turn path. **Final verdict: SECURE-TO-SHIP — no remaining Critical/High; A cannot reach B's sessions, memory, or learning.**

## Known v1 limitations (documented, not fixed)

All judged non-blocking for the within-org threat model; recorded for a future pass:

1. **Operator-side traces + fine-tune trajectories are not per-user-partitioned.** `$HARNESS_HOME/traces` + `…/trajectories` stay top-level. They are **operator-only** artifacts, **never served over the API**, so they are not a *turn-surfaced* cross-user leak; partitioning them is a noted follow-up.
2. **The admin learning CLI operates on the legacy top-level corpus.** `sov learning status|export|prune` (`learningStatus/Export/Prune`) read/prune the legacy top-level corpus, not per-user — they are operator-side admin commands, out of the per-turn path.
3. **A synthesizer prompt-label cosmetically shows the legacy observations path.** Display-only text in the synthesizer prompt; **no data exposure** (the actual observe/persist paths are owner-scoped).
4. **`timingSafeEqual` early-returns on a length mismatch.** Pre-existing, codebase-wide (it is the same compare shape as the existing single-token auth), and acceptable within the non-hostile within-org threat model — a token *length* oracle is not a meaningful disclosure for trusted users.
5. **The E-T4 tightening** (events/approvals now require the session to exist in the DB) is a deliberate behavior change, noted here for completeness — it removes a path that would attach to / mint a bus for an unknown session id.

## Tests

- **TS suite — ~2957 pass / 0 fail / 14 skip** in a clean run. Up from the Phase-D v0.6.21 baseline (~2861) from the new principals + auth + ownership + per-user-memory + per-user-learning + e2e-isolation coverage (`principals` / `sessionOwnership` / `multiUserIsolation` / memory `userScope` / learning `userScope` / `memoryToolUserScope` / `compactOwner` suites). Gate criterion unchanged: "no new failures beyond the known env-only set" (the ambient-config learning-observer tests pass on a clean `HARNESS_HOME` / in CI).
- **Lint + typecheck** — clean (`biome check`; `tsc --noEmit`).
- **Go suite** — unchanged by this phase (no `packages/tui/` change).
- **Post-upgrade binary smoke** — the released v0.6.22 binary boots a gateway configured with two principals (alice/bob); as alice, `POST /sessions` returns a session id; as bob, `GET /sessions/<aliceId>` returns **404** and `GET /sessions` does not list alice's session; no token returns **401** (principals mode requires one even on loopback). Proves multi-user isolation ships in the binary. Logged in `docs/06-testing/testing-log.md`.

## Notes

- **No bundle changes** — the Phase-E surface is entirely in `src/` (`server/principals.ts`, `server/auth.ts`, `server/app.ts`/`index.ts`, `cli/gatewayCommand.ts`, `agent/sessionDb.ts`, `server/routes/{sessions,turns,events,approvals}.ts`, `memory/{scope,bounded,provider}.ts`, `learning/{paths,instinctStore}.ts`, `learning-layer/`, `server/sessionContext.ts`/`runtime.ts`, `tools/MemoryTool.ts`, `compact/compactor.ts`, `config/schema.ts`), `tests/`, and `docs/`. No `packages/tui/` change, no `bundle-default/` change.
- **Default surfaces unchanged.** The default `sov` (TUI), `sov serve` (OpenAI API), and `sov drive` (headless) experiences are byte-identical: they configure no principals → implicit single principal, legacy top-level memory/learning paths, no ownership enforcement. `sov serve`'s own auth + `openai:`-namespacing are separate and untouched.
- **Engine-agnostic by construction.** Everything sits above the HTTP+SSE protocol seam (`src/server/schema.ts` + the routes) and the SQLite session model, never the runtime's internals — so it survives a future agent-core swap, exactly like the rest of the gateway program. **The protocol is the seam.**
- **Learning-loop soak continues in parallel — untouched.** Recall is still **ON by default** (`learning.recall.enabled`, since v0.6.16) and capture + synthesis stay on; Phase E did not disable recall or learning (a roadmap execution requirement). The learning layer rides above the protocol seam; Phase E only gave it a per-user *namespace* (derived from the session owner) — the loop itself is unchanged. The `## ⚠️ ACTIVE FOCUS — Learning-loop soak` banner in `CLAUDE.md`/`AGENTS.md` stays the standing #1 focus; this gateway phase is a separate, parallel track.

## Cross-repo record-keeping (flag for a docs-repo session)

The roadmap + decision record are canonical in `~/code/sovereign-ai-docs` and this repo can't commit there. A docs-repo session should reflect **Phase E shipped (v0.6.22)** against the multi-channel-gateway differentiator (ADR H-0010) and the run-anywhere program tracker (**A + B + C + D + E done; F remains**), and mark the `multi-user-memory-scoping` blocker resolved. This cross-repo sync (A/B/C/D/E shipped) is **still pending** for a future docs session.
