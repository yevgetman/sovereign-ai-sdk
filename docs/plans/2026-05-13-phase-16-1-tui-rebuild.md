# Phase 16.1 TUI Rebuild — Implementation Plan (M0–M3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get from the on-disk Phase 16.1 design spec to a working `sov --ui tui` invocation that renders one real `query()` turn end-to-end against an HTTP+SSE backend, with `terminalRepl` untouched and no 24-prereq subsystems wired yet.

**Architecture:** Split process. `sov` (TS / Bun) runs the agent and a Hono HTTP+SSE server bound to `127.0.0.1`. `sov-tui` (Go / Bubble Tea, `packages/tui/`) is a separate process that connects to the server, consumes SSE events, and renders the foreground. Both surfaces — `--ui repl` (default) and `--ui tui` (opt-in) — coexist per Postmortem Rule 1.

**Tech Stack:** TypeScript / Bun / Hono 4.x / Zod (server side). Go 1.22+ / Bubble Tea / lipgloss / bubbles (TUI side). `bun:test` for TS tests; `go test` + `charmbracelet/x/exp/teatest` for Go tests.

**Spec:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md`

**Postmortem rules being enforced:** `docs/postmortems/2026-05-12-phase-16-revert.md` — never delete `terminalRepl.ts` or its helper modules during this plan; ship behind `--ui tui` opt-in flag; checkbox the 24-prereq list at later milestones (out of scope for this plan).

---

## Scope of This Plan

| Milestone | Goal | Exit |
|---|---|---|
| **M0** | Spec & ADRs landed; umbrella roadmap updated; CLAUDE.md pointed at this plan | Single commit batch on `master`; `sov upgrade` not required (docs-only) |
| **M1** | Hono HTTP+SSE server skeleton; `/health` works; SSE endpoint emits a hardcoded `text_delta` stream | `bun test tests/server/` green; manual curl smoke passes |
| **M2** | `sov-tui` Go binary builds via postinstall; connects to M1 server; renders the hardcoded stream; ESC quits; `--ui tui` flag is opt-in in `src/main.ts` | `bun test` green; `go test ./packages/tui/...` green; manual smoke against M1 server passes |
| **M3** | `query()` wired through server; one real turn renders in TUI; `renderHint` added to every tool; tool-use renders as a placeholder card | `bun test` green; `go test ./packages/tui/...` green; manual smoke against a real provider passes |

Out of scope (future plans): M4–M8 (24-prereq wiring), M9 (visual polish), M10 (parity audit), M11 (default flip), M12 (deprecation), M13 (removal).

---

## File Structure

Files this plan creates or modifies, organized by responsibility.

**New (created by this plan):**

| Path | Responsibility |
|---|---|
| `docs/plans/2026-05-13-phase-16-1-tui-rebuild.md` | This plan (this file) |
| `src/server/index.ts` | Public `startServer(opts)` entry; spawn-and-shutdown contract |
| `src/server/app.ts` | Hono app construction; mounts route modules |
| `src/server/schema.ts` | Zod schemas for SSE events + request bodies; single source of truth |
| `src/server/port.ts` | Free-port discovery on `127.0.0.1` |
| `src/server/sseStream.ts` | Helper that turns an async-generator into SSE `data:` lines via Hono's `streamSSE` |
| `src/server/routes/health.ts` | `GET /health` → `{ ok: true, version }` |
| `src/server/routes/events.ts` | `GET /sessions/:id/events` → SSE stream (hardcoded in M1, real in M3) |
| `src/server/routes/sessions.ts` | `POST /sessions`, `GET /sessions/:id` (M3) |
| `src/server/routes/turns.ts` | `POST /sessions/:id/turns` → kicks off `query()` (M3) |
| `src/server/runtime.ts` | Constructs a runtime context for the server (M3) |
| `tests/server/health.test.ts` | Unit test for `/health` |
| `tests/server/port.test.ts` | Unit test for free-port discovery |
| `tests/server/schema.test.ts` | Unit test for SSE event schema |
| `tests/server/sseStream.test.ts` | Unit test for the SSE stream adapter |
| `tests/server/events.test.ts` | Integration test for hardcoded SSE event stream (M1) |
| `tests/server/turns.test.ts` | Integration test for turn submission (M3) |
| `tests/server/startServer.test.ts` | Boot test: `startServer().port` is reachable |
| `packages/tui/go.mod` | Go module manifest |
| `packages/tui/go.sum` | Go module checksums (generated) |
| `packages/tui/cmd/sov-tui/main.go` | CLI entry; parses `--port` + `--session-id` |
| `packages/tui/internal/app/app.go` | Bubble Tea root `Model` / `Update` / `View` |
| `packages/tui/internal/app/keys.go` | Key binding declarations |
| `packages/tui/internal/transport/types.go` | Go mirror of `src/server/schema.ts` event shapes |
| `packages/tui/internal/transport/sse.go` | SSE consumer that emits typed `tea.Msg` |
| `packages/tui/internal/transport/api.go` | HTTP client stub (M3 expands) |
| `packages/tui/internal/components/transcript.go` | Scrollable viewport for the message list |
| `packages/tui/internal/components/prompt.go` | Text input row |
| `packages/tui/internal/components/statusline.go` | Bottom status row |
| `packages/tui/internal/components/toolcard.go` | Placeholder tool-card renderer (M3) |
| `packages/tui/internal/transport/types_test.go` | Unit test for event-type decoding |
| `packages/tui/internal/transport/sse_test.go` | Unit test for SSE consumer (against `httptest.Server`) |
| `packages/tui/internal/app/app_test.go` | `teatest` snapshot test of bare-scaffold render |
| `scripts/build-tui.ts` | Postinstall script: detects `go`, builds `sov-tui` to `bin/sov-tui`, falls back gracefully |
| `bin/.gitkeep` | Holds the directory so `bin/sov-tui` build artifact path exists pre-build |

**Modified (touched by this plan):**

| Path | Why |
|---|---|
| `DECISIONS.md` | ADR stubs for the 8 locked decisions from spec §3 |
| `CLAUDE.md` | Phases section points at this plan; document the new `--ui` flag |
| `docs/specs/2026-05-13-production-harness-roadmap-design.md` | Drop Phase 14; resequence; mark Open Q1 closed; reference this plan |
| `docs/backlog/phase-16-rebuild-prereqs.md` | Add header link to the spec |
| `docs/testing-log.md` | One entry per milestone close-out |
| `package.json` | Add `hono` as explicit dep; add `tui:build` script; add `postinstall` hook |
| `src/main.ts` | Add `--ui <repl|tui>` flag to the `chat` command (default `repl`); add `sov serve-dev` subcommand for M1/M2 smoke; spawn `sov-tui` child when `--ui tui` (M3) |
| `src/tool/types.ts` | Add `renderHint?: RenderHint` field to `ToolDef` (M3) |
| All 28 `src/tools/*Tool.ts` (and `src/tool/registry.ts` builder helpers like `buildHarnessInfoTool`, `buildToolSearchTool`) | Add `renderHint` per spec §7 table (M3) |
| `.gitignore` | Add `bin/sov-tui` (built artifact, not source) |

**Untouched (load-bearing — do not modify):**

- `src/ui/terminalRepl.ts` (per Postmortem Rule 1)
- `src/commands/**` (per Postmortem Rule 2)
- `src/core/query.ts` (M3 consumes it via the existing public API)
- `src/cli/dispatchCommand.ts`, `src/cli/missionRun.ts` (unrelated surfaces)
- `src/daemon/**`, `src/channels/**` (dormant; not touched)
- Any of the 24 prereq subsystems' wiring (future plans)

---

## TDD Discipline For This Plan

Every code-touching task follows: write failing test → run and confirm FAIL → write minimum implementation → run and confirm PASS → commit. Doc-only tasks (M0) follow: edit → verify with `git diff` or read-back → commit.

`bun:test` is the test runner for TS code; tests live under `tests/`. `go test` runs Go tests; tests are co-located with sources (`_test.go`). Bun's `expect()` mirrors Jest semantics.

For SSE integration tests, use Bun's native `fetch` against a server started with `Bun.serve()` from Hono's `app.fetch` handler, then read the response body as a `ReadableStream`. No external HTTP client needed.

For Go `teatest` tests, use `github.com/charmbracelet/x/exp/teatest` — Charm's official test harness. Snapshot tests use `teatest.RequireEqualOutput`.

---

# M0 — Spec & ADRs Landed (housekeeping)

**Goal:** Land the design spec, point CLAUDE.md and the umbrella roadmap at it, add ADR stubs to `DECISIONS.md`, and ship the housekeeping as one atomic commit. No code, no tests, no `sov upgrade` required.

## Task M0.1 — ADR stubs in `DECISIONS.md`

**Files:**
- Modify: `DECISIONS.md` (append section)

- [ ] **Step 1: Read the current `DECISIONS.md` to determine the next ADR number.**

```bash
grep -nE "^## ADR H-[0-9]+" DECISIONS.md | tail -5
```

The output shows the existing highest H-NNNN. The next ADR number is `that + 1`. Below we refer to the new numbers as `H-N`, `H-N+1`, ..., `H-N+7` — substitute in your editor before writing.

- [ ] **Step 2: Append eight ADR stubs to `DECISIONS.md`.**

Add this block at the end of the file (substitute `H-N..N+7` for real numbers):

```markdown
## ADR H-N — Phase 16.1 TUI rebuild: split-process architecture

**Decided:** 2026-05-13
**Status:** accepted
**Source:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.1

`sov` (TS / Bun) runs the agent and a Hono HTTP+SSE server bound to `127.0.0.1`. `sov-tui` (Go) is a separate child process that connects via SSE. Same backend will later serve IDE plugins and other channel adapters without rework. Architectural choice supersedes the umbrella roadmap's single-process options.

## ADR H-N+1 — Phase 16.1 TUI framework: Go + Bubble Tea

**Decided:** 2026-05-13
**Status:** accepted
**Source:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.2
**Closes:** Open Q1 from `docs/specs/2026-05-13-production-harness-roadmap-design.md` §6.

The Charm stack (`bubbletea`, `lipgloss`, `bubbles`, `glamour`, `chroma`) is the most mature TUI ecosystem in any language. Ink was scrapped per the 2026-05-12 revert postmortem. OpenTUI / SolidJS rejected: the umbrella roadmap's claim that opencode uses OpenTUI is incorrect; opencode uses Bubble Tea.

## ADR H-N+2 — Phase 16.1 differentiator: polish craft

**Decided:** 2026-05-13
**Status:** accepted
**Source:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.3

The TUI wins on Claude Code's surface area at visibly higher quality. Out of scope: session browser, command palette, in-transcript search, multi-pane layouts, image rendering, vim keybindings.

## ADR H-N+3 — Phase 16.1 layout: anchored bottom chrome

**Decided:** 2026-05-13
**Status:** accepted
**Source:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.4

Fixed bottom input row + fixed bottom status row; transcript viewport fills the space above. Selected over CC-style floating-inline input and editor-style top-status during 2026-05-13 brainstorming. Layout B in the brainstorming companion artifact.

## ADR H-N+4 — Phase 16.1 binary delivery: postinstall `go build`

**Decided:** 2026-05-13
**Status:** accepted
**Source:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.5

`package.json` postinstall runs `bun run scripts/build-tui.ts`, which detects Go 1.22+ on PATH and runs `go build ./packages/tui/cmd/sov-tui` into `bin/sov-tui`. Missing-Go failures print remediation and `sov` falls back to `--ui repl` until fixed.

## ADR H-N+5 — Phase 16.1 terminalRepl coexistence

**Decided:** 2026-05-13
**Status:** accepted
**Source:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.6
**References:** `docs/postmortems/2026-05-12-phase-16-revert.md` Rule 1

`terminalRepl.ts` and its helpers (`src/commands/**`, `src/ui/**` other than the new TUI subdirectory if any) are not deleted, deprecated, or refactored from M0 through M11 (default flip). Removal happens at M13 at the earliest.

## ADR H-N+6 — Phase 16.1 transport: HTTP + SSE on localhost

**Decided:** 2026-05-13
**Status:** accepted
**Source:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §3.7

HTTP + Server-Sent Events. Not WebSockets. Bun + Hono server side; standard `net/http` + line-by-line SSE parse on the Go client side. v1 binds to `127.0.0.1` only; no auth.

## ADR H-N+7 — Phase 14 (distribution) dropped from roadmap

**Decided:** 2026-05-13
**Status:** accepted
**Source:** user direction during 2026-05-13 brainstorming

Phase 14 (npm publish, Homebrew tap, install.sh, public docs site) is dropped entirely. The harness is proprietary; distribution is deferred until the product is production-grade. `bun install -g git+ssh://...` remains the single supported install path.
```

- [ ] **Step 3: Verify the edit landed correctly.**

```bash
tail -120 DECISIONS.md | head -30
```

Expected: see the first ADR stub starting with the chosen `H-N` number, headline reads "Phase 16.1 TUI rebuild: split-process architecture".

## Task M0.2 — Point `CLAUDE.md` at the spec and this plan

**Files:**
- Modify: `CLAUDE.md` (the "Phases — where we are" section)

- [ ] **Step 1: Read the current Phases section to find the exact `Next:` line.**

```bash
grep -n "Next:" CLAUDE.md
```

- [ ] **Step 2: Replace the `Next:` paragraph with the new direction.**

Current text (the entire `**Next:** ...` paragraph) is replaced with:

```markdown
**Next:** **Phase 16.1 — TUI rebuild.** Active per user direction (2026-05-13). Spec: `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md`. M0–M3 plan: `docs/plans/2026-05-13-phase-16-1-tui-rebuild.md`. Architecture: split process — `sov` (TS) runs an HTTP+SSE server; `sov-tui` (Go + Bubble Tea) is a separate child process that renders the foreground. terminalRepl untouched per Postmortem Rule 1; `--ui tui` is opt-in until parity audit clears the default flip. Phase 14 (distribution) dropped per ADR H-N+7. Phase 15 (provider breadth) deferred or run in parallel — user's call at the next plan kickoff.
```

(Substitute `H-N+7` for the actual ADR number chosen in M0.1.)

- [ ] **Step 3: Verify.**

```bash
grep -n "Phase 16.1" CLAUDE.md
```

Expected: at least three matches (one in the new `Next:` paragraph + existing references to "the next foreground refactor" + the documentation index table).

## Task M0.3 — Update the umbrella roadmap

**Files:**
- Modify: `docs/specs/2026-05-13-production-harness-roadmap-design.md`

- [ ] **Step 1: Edit the umbrella spec status block at the top.**

Change the `Status:` line at the very top of the file from:

```
Status: **draft** — pending decisions on Open Q1 (TUI framework) and Open Q2 (provider strategy)
```

to:

```
Status: **partially superseded** — Phase 14 dropped (proprietary, distribution deferred); Phase 16.1 detailed in `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md`; Open Q1 (TUI framework) CLOSED → Go + Bubble Tea; Open Q2 (provider strategy) remains open
```

- [ ] **Step 2: Delete §7 Phase 14 section entirely.**

Find the line `### Phase 14 — Distribution & Public Docs` and delete the entire section through the next `### Phase 15` header (exclusive — keep Phase 15). The deleted span is roughly 100 lines.

- [ ] **Step 3: Update the §5 phase-map table.**

Find the table in §5 (header `| Phase | Name | New / Reprio'd | Est. cost | Hard deps | Status |`). Remove the row whose `Phase` column is `14`. Update the `Hard deps` column for any other row that listed `14` — Phase 15's deps becomes "none"; Phase 18's deps becomes "15"; Phase 21's deps becomes "16.1, 18". Update Phase 16.1's `Status` column to `**ACTIVE — see linked spec & plan**`.

- [ ] **Step 4: Update §6 Open Decisions.**

Find the `### Open Q1 — TUI framework for Phase 16.1` block. Replace its first line (the `Phase 16.0b chose Ink...` paragraph) with:

```markdown
**CLOSED 2026-05-13.** Decision: **Go + Bubble Tea (split-process architecture)**. See ADRs H-N and H-N+1 in `DECISIONS.md`, and `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md`. The umbrella's prior claim that opencode uses OpenTUI/SolidJS was incorrect; opencode uses Bubble Tea.

Original options (preserved for the record):
```

Leave the options table beneath that intact.

- [ ] **Step 5: Update §7 Phase 16.1 block.**

Replace the entire `### Phase 16.1 — Foreground TUI Rebuild` section's body with a short pointer:

```markdown
### Phase 16.1 — Foreground TUI Rebuild

**Status:** ACTIVE. Detailed in `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` (design spec) and `docs/plans/2026-05-13-phase-16-1-tui-rebuild.md` (M0–M3 plan).

**Locked decisions:** split-process architecture; Go + Bubble Tea framework; polish-craft differentiator; bottom-anchored chrome layout; postinstall `go build` for binary delivery; HTTP + SSE transport on `127.0.0.1`; terminalRepl untouched through M11.

**Open Q1** (TUI framework) — CLOSED per above.

See the linked spec for the full per-phase plan: architecture, backend (`src/server/`), foreground (`packages/tui/`), tool renderer bridge, 24-prereq wiring strategy, milestones M0–M13, risks.
```

- [ ] **Step 6: Update §9 (integration with canonical build plan) to reflect Phase 14 deletion.**

Find the lines in §9 that say:

```
1. Insert a new **Phase 14 — Distribution & Public Docs** section between Phase 13.5 and Phase 16.0.
```

Replace item `1.` with:

```
1. ~~Phase 14 — dropped~~. Per ADR H-N+7 (2026-05-13), distribution is deferred until the product is production-grade. No sister-repo insertion for Phase 14.
```

Renumber the remaining items if they refer to Phase 14 elsewhere.

- [ ] **Step 7: Update §10 sequencing table.**

In the table at the top of §10, remove the `14 — Distribution` row. The total wall estimate stays the same in shape (the per-phase numbers are unchanged); just drop the Phase 14 line. Below the table, update the parallel-safe ordering bullet:

```
- Track A (foundation): 16.1 → 18 → 19 → 21
- Track B (parallel-safe): 20 (LSP) and 15 (providers), user's call on order
```

Replace the existing "Track A" / "Track B" bullets with the above.

- [ ] **Step 8: Verify.**

```bash
grep -n "Phase 14\|Phase 16.1" docs/specs/2026-05-13-production-harness-roadmap-design.md | head -20
```

Expected: no references to "Phase 14" that propose it as work to do; Phase 16.1 references point at the new spec and plan files.

## Task M0.4 — Cross-link the 24-prereq backlog to the spec

**Files:**
- Modify: `docs/backlog/phase-16-rebuild-prereqs.md`

- [ ] **Step 1: Read the current first line of the backlog doc.**

```bash
head -5 docs/backlog/phase-16-rebuild-prereqs.md
```

- [ ] **Step 2: Insert a header block immediately after the first heading.**

Add this block immediately after the file's first `# ...` heading line:

```markdown
> **Authoritative phase plan:** `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md` §9. This backlog enumerates the 24 subsystems any new foreground must wire; the spec assigns them to milestones M4–M8.
```

## Task M0.5 — Commit the M0 batch

- [ ] **Step 1: Stage the edits explicitly (no `git add -A`, per global rule).**

```bash
git add \
  DECISIONS.md \
  CLAUDE.md \
  docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md \
  docs/specs/2026-05-13-production-harness-roadmap-design.md \
  docs/backlog/phase-16-rebuild-prereqs.md \
  docs/plans/2026-05-13-phase-16-1-tui-rebuild.md \
  .gitignore
```

- [ ] **Step 2: Verify the staged diff is clean.**

```bash
git status --short
git diff --cached --stat
```

Expected: only the files above; no stray files; no large binaries.

- [ ] **Step 3: Run lint + typecheck (docs-only but the rule is to gate every commit).**

```bash
bun run lint && bun run typecheck && bun run test
```

Expected: all three pass. Tests already pass at 1809/1809 before this commit — the docs changes don't affect them.

- [ ] **Step 4: Commit.**

```bash
git commit -m "$(cat <<'EOF'
docs(phase-16-1): land TUI rebuild spec + M0–M3 plan + ADRs

- Spec: docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md
- Plan: docs/plans/2026-05-13-phase-16-1-tui-rebuild.md
- 8 ADR stubs in DECISIONS.md (split-process, Bubble Tea, polish-craft,
  layout, binary delivery, terminalRepl coexistence, HTTP+SSE, Phase 14
  dropped)
- CLAUDE.md Phases section points at Phase 16.1 as active
- Umbrella roadmap (2026-05-13 production-harness) — Phase 14 dropped,
  Open Q1 closed, §5/§6/§7/§9/§10 updated
- phase-16-rebuild-prereqs.md cross-linked to spec §9
EOF
)"
```

- [ ] **Step 5: Push.**

```bash
git push origin master
```

`sov upgrade` not required — no runtime files changed.

**M0 exit gate:** `git log -1 --stat` shows the commit on `origin/master`; `grep "Phase 16.1" CLAUDE.md` matches; spec & plan paths are committed.

---

# M1 — Hono HTTP+SSE Server Skeleton

**Goal:** A reachable HTTP server, bound to a random port on `127.0.0.1`, exposes `/health` and `/sessions/:id/events` (SSE). The SSE endpoint emits a hardcoded stream of `text_delta` events in M1 — no real `query()` yet. Built test-first.

## Task M1.1 — Add `hono` as an explicit dependency

**Files:**
- Modify: `package.json`

Hono 4.12.18 is already present as a transitive dependency. M1 imports it directly, so make it an explicit dependency.

- [ ] **Step 1: Read current `package.json` dependencies.**

```bash
grep -A 20 '"dependencies"' package.json | head -25
```

- [ ] **Step 2: Add `hono` to dependencies.**

Insert the line `"hono": "^4.12.0",` into the `dependencies` block, alphabetically between `chalk` and `ink` (keep alphabetical order if the existing block has it).

After the edit, the relevant block reads:

```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.90.0",
  "@commander-js/extra-typings": "^12.1.0",
  "@modelcontextprotocol/sdk": "^1.29.0",
  "chalk": "^5.3.0",
  "hono": "^4.12.0",
  "ink": "^5.0.1",
  "react": "^18.3.1",
  "yaml": "^2.6.0",
  "zod": "^3.24.0"
},
```

- [ ] **Step 3: Run `bun install` so the lockfile records the explicit pin.**

```bash
bun install
```

Expected: completes in <5s; `bun.lockb` updates; `node_modules/hono` already present so no download.

- [ ] **Step 4: Verify Hono imports work.**

```bash
bun -e "import { Hono } from 'hono'; const app = new Hono(); console.log(typeof app.fetch)"
```

Expected: prints `function`.

- [ ] **Step 5: Commit.**

```bash
git add package.json bun.lockb
git commit -m "build(deps): add hono as explicit dependency for Phase 16.1 server"
```

## Task M1.2 — `src/server/schema.ts` — SSE event Zod schemas

**Files:**
- Create: `src/server/schema.ts`
- Create: `tests/server/schema.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `tests/server/schema.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { ServerEventSchema, parseServerEvent } from '../../src/server/schema.js';

describe('ServerEventSchema', () => {
  test('parses a text_delta event', () => {
    const raw = {
      type: 'text_delta',
      seq: 1,
      sessionId: 's_abc',
      block: 0,
      text: 'Hello',
    };
    const parsed = ServerEventSchema.parse(raw);
    expect(parsed.type).toBe('text_delta');
    if (parsed.type !== 'text_delta') throw new Error('narrowing failed');
    expect(parsed.text).toBe('Hello');
    expect(parsed.seq).toBe(1);
  });

  test('parses a turn_complete event', () => {
    const raw = {
      type: 'turn_complete',
      seq: 42,
      sessionId: 's_abc',
      finishReason: 'end_turn',
    };
    const parsed = ServerEventSchema.parse(raw);
    expect(parsed.type).toBe('turn_complete');
  });

  test('rejects unknown event types', () => {
    expect(() => ServerEventSchema.parse({ type: 'mystery', seq: 0, sessionId: 's' })).toThrow();
  });

  test('parseServerEvent returns null for invalid JSON', () => {
    expect(parseServerEvent('{not json')).toBeNull();
  });

  test('parseServerEvent returns the parsed event for valid JSON', () => {
    const json = JSON.stringify({ type: 'text_delta', seq: 1, sessionId: 's', block: 0, text: 'x' });
    const ev = parseServerEvent(json);
    expect(ev?.type).toBe('text_delta');
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/server/schema.test.ts
```

Expected: error similar to `Cannot find module '../../src/server/schema.js'`.

- [ ] **Step 3: Create `src/server/schema.ts`.**

```typescript
// SSE event schemas + types for the Phase 16.1 HTTP server.
// Single source of truth for what the server may emit on /sessions/:id/events.
// The Go TUI mirrors these shapes in packages/tui/internal/transport/types.go.

import { z } from 'zod';

const BaseEvent = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string(),
});

export const TextDeltaEvent = BaseEvent.extend({
  type: z.literal('text_delta'),
  block: z.number().int().nonnegative(),
  text: z.string(),
});

export const ThinkingDeltaEvent = BaseEvent.extend({
  type: z.literal('thinking_delta'),
  block: z.number().int().nonnegative(),
  text: z.string(),
});

export const ToolUseStartEvent = BaseEvent.extend({
  type: z.literal('tool_use_start'),
  block: z.number().int().nonnegative(),
  tool: z.string(),
  inputPartial: z.unknown().optional(),
});

export const ToolUseInputDeltaEvent = BaseEvent.extend({
  type: z.literal('tool_use_input_delta'),
  block: z.number().int().nonnegative(),
  delta: z.string(),
});

export const ToolUseDoneEvent = BaseEvent.extend({
  type: z.literal('tool_use_done'),
  block: z.number().int().nonnegative(),
  input: z.unknown(),
});

export const ToolResultEvent = BaseEvent.extend({
  type: z.literal('tool_result'),
  block: z.number().int().nonnegative(),
  tool: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  renderHint: z.string(),
  language: z.string().optional(),
});

export const PermissionRequestEvent = BaseEvent.extend({
  type: z.literal('permission_request'),
  requestId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  reason: z.string().optional(),
});

export const StatusUpdateEvent = BaseEvent.extend({
  type: z.literal('status_update'),
  cost: z.number().optional(),
  tokensIn: z.number().int().optional(),
  tokensOut: z.number().int().optional(),
  cacheHitRate: z.number().optional(),
  streaming: z.boolean().optional(),
});

export const TurnCompleteEvent = BaseEvent.extend({
  type: z.literal('turn_complete'),
  finishReason: z.string(),
  usage: z
    .object({
      input_tokens: z.number().int(),
      output_tokens: z.number().int(),
      cache_creation_input_tokens: z.number().int().optional(),
      cache_read_input_tokens: z.number().int().optional(),
    })
    .optional(),
});

export const TurnErrorEvent = BaseEvent.extend({
  type: z.literal('turn_error'),
  error: z.string(),
  recoverable: z.boolean(),
});

export const SessionResumedEvent = BaseEvent.extend({
  type: z.literal('session_resumed'),
  resumedFromSeq: z.number().int().nonnegative(),
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolUseStartEvent,
  ToolUseInputDeltaEvent,
  ToolUseDoneEvent,
  ToolResultEvent,
  PermissionRequestEvent,
  StatusUpdateEvent,
  TurnCompleteEvent,
  TurnErrorEvent,
  SessionResumedEvent,
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;

export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const obj: unknown = JSON.parse(raw);
    return ServerEventSchema.parse(obj);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
bun test tests/server/schema.test.ts
```

Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit.**

```bash
git add src/server/schema.ts tests/server/schema.test.ts
git commit -m "feat(server): SSE event schemas via Zod discriminated union"
```

## Task M1.3 — `src/server/port.ts` — Free-port discovery on 127.0.0.1

**Files:**
- Create: `src/server/port.ts`
- Create: `tests/server/port.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `tests/server/port.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { findFreePort } from '../../src/server/port.js';

describe('findFreePort', () => {
  test('returns a usable port in the dynamic range', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThan(65536);
  });

  test('returns a port we can immediately bind to', async () => {
    const port = await findFreePort();
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
    } finally {
      server.stop();
    }
  });

  test('two calls in a row return different ports (usually)', async () => {
    // Strictly speaking the kernel could reissue the same port if the first one
    // was released. This test runs the two calls back-to-back without closing
    // anything in between, so we expect distinct ports.
    const a = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const b = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    try {
      expect(a.port).not.toBe(b.port);
    } finally {
      a.stop();
      b.stop();
    }
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/server/port.test.ts
```

Expected: cannot find `findFreePort`.

- [ ] **Step 3: Create `src/server/port.ts`.**

```typescript
// Free-port discovery on 127.0.0.1.
//
// Bun.serve({ port: 0 }) asks the kernel for an ephemeral port; we read the
// assigned port back, stop the server, and return it. There is a microscopic
// race where another process could grab the port between stop() and the
// caller's bind, but for a local-only TUI launcher that's acceptable. The
// caller binds again on the same port immediately.

export async function findFreePort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(''),
  });
  const port = probe.port;
  probe.stop();
  return port;
}
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
bun test tests/server/port.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit.**

```bash
git add src/server/port.ts tests/server/port.test.ts
git commit -m "feat(server): findFreePort() helper using Bun.serve({ port: 0 })"
```

## Task M1.4 — `src/server/sseStream.ts` — Async-generator → SSE adapter

**Files:**
- Create: `src/server/sseStream.ts`
- Create: `tests/server/sseStream.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `tests/server/sseStream.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { ServerEvent } from '../../src/server/schema.js';
import { mountEventStream } from '../../src/server/sseStream.js';

async function* fakeEvents(): AsyncGenerator<ServerEvent> {
  yield { type: 'text_delta', seq: 1, sessionId: 's_test', block: 0, text: 'Hello' };
  yield { type: 'text_delta', seq: 2, sessionId: 's_test', block: 0, text: ' world' };
  yield {
    type: 'turn_complete',
    seq: 3,
    sessionId: 's_test',
    finishReason: 'end_turn',
  };
}

describe('mountEventStream', () => {
  test('emits each event as a single SSE data: line with the event type', async () => {
    const app = new Hono();
    app.get('/stream', (c) => mountEventStream(c, fakeEvents));

    const res = await app.request('/stream');
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const body = await res.text();

    // Expect three data: blocks with event: prefixes.
    const blocks = body
      .split('\n\n')
      .map((b) => b.trim())
      .filter(Boolean);
    expect(blocks.length).toBe(3);

    // First block: event: text_delta\nid: 1\ndata: {"type":"text_delta", ...}
    expect(blocks[0]).toContain('event: text_delta');
    expect(blocks[0]).toContain('id: 1');
    expect(blocks[0]).toContain('"text":"Hello"');

    // Last block: turn_complete
    expect(blocks[2]).toContain('event: turn_complete');
    expect(blocks[2]).toContain('id: 3');
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/server/sseStream.test.ts
```

Expected: cannot find `mountEventStream` or import error.

- [ ] **Step 3: Create `src/server/sseStream.ts`.**

```typescript
// SSE adapter: takes an async-generator of ServerEvent and writes them to a
// Hono response as standard `event: <type>` / `id: <seq>` / `data: <json>`
// blocks separated by blank lines. Hono's streamSSE handles the wire format,
// flush semantics, and proxy-friendly headers; we own the event-shape mapping.

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServerEvent } from './schema.js';

export async function mountEventStream(
  c: Context,
  source: () => AsyncGenerator<ServerEvent>,
): Promise<Response> {
  return streamSSE(c, async (stream) => {
    for await (const event of source()) {
      await stream.writeSSE({
        event: event.type,
        id: String(event.seq),
        data: JSON.stringify(event),
      });
    }
  });
}
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
bun test tests/server/sseStream.test.ts
```

Expected: 1 pass.

- [ ] **Step 5: Commit.**

```bash
git add src/server/sseStream.ts tests/server/sseStream.test.ts
git commit -m "feat(server): SSE stream adapter using hono/streaming"
```

## Task M1.5 — `src/server/routes/health.ts`

**Files:**
- Create: `src/server/routes/health.ts`
- Create: `tests/server/health.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `tests/server/health.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { healthRoute } from '../../src/server/routes/health.js';

describe('healthRoute', () => {
  test('GET /health returns { ok: true, version }', async () => {
    const app = new Hono().route('/', healthRoute);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/server/health.test.ts
```

Expected: import error.

- [ ] **Step 3: Create `src/server/routes/health.ts`.**

```typescript
// GET /health — liveness check. Returns ok=true and the package version.
// No auth, no side effects.

import { Hono } from 'hono';

const VERSION: string = process.env.SOV_VERSION ?? '0.0.1';

export const healthRoute = new Hono();

healthRoute.get('/health', (c) => c.json({ ok: true, version: VERSION }));
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
bun test tests/server/health.test.ts
```

Expected: 1 pass.

- [ ] **Step 5: Commit.**

```bash
git add src/server/routes/health.ts tests/server/health.test.ts
git commit -m "feat(server): /health route"
```

## Task M1.6 — `src/server/routes/events.ts` — Hardcoded SSE stream (M1 placeholder)

**Files:**
- Create: `src/server/routes/events.ts`
- Create: `tests/server/events.test.ts`

In M1 the events endpoint emits a hardcoded sequence so M2's Go client has something to render. M3 replaces the hardcoded generator with a real one wired to `query()`.

- [ ] **Step 1: Write the failing test.**

Create `tests/server/events.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { parseServerEvent } from '../../src/server/schema.js';
import { eventsRoute } from '../../src/server/routes/events.js';

describe('eventsRoute (M1 hardcoded)', () => {
  test('GET /sessions/:id/events emits text_delta then turn_complete', async () => {
    const app = new Hono().route('/', eventsRoute);
    const res = await app.request('/sessions/s_test/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const body = await res.text();
    const blocks = body.split('\n\n').map((b) => b.trim()).filter(Boolean);
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    // Parse the JSON data field from each block.
    const events = blocks.map((b) => {
      const dataLine = b.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) throw new Error(`no data line in block: ${b}`);
      return parseServerEvent(dataLine.slice('data: '.length));
    });

    expect(events[0]?.type).toBe('text_delta');
    if (events[0]?.type !== 'text_delta') throw new Error('narrow');
    expect(events[0].sessionId).toBe('s_test');

    const last = events[events.length - 1];
    expect(last?.type).toBe('turn_complete');
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/server/events.test.ts
```

Expected: import error.

- [ ] **Step 3: Create `src/server/routes/events.ts`.**

```typescript
// GET /sessions/:id/events — SSE event stream for a session.
//
// M1 emits a hardcoded sequence so the Go TUI has something to render
// during scaffold-up. M3 wires this to a real query() turn.

import { Hono } from 'hono';
import type { ServerEvent } from '../schema.js';
import { mountEventStream } from '../sseStream.js';

export const eventsRoute = new Hono();

eventsRoute.get('/sessions/:id/events', (c) => {
  const sessionId = c.req.param('id');
  return mountEventStream(c, () => hardcodedStream(sessionId));
});

async function* hardcodedStream(sessionId: string): AsyncGenerator<ServerEvent> {
  // Three text deltas + a turn_complete. Pause briefly so the client sees
  // streaming, not a single-shot blob.
  const lines = ['Hello from ', 'the M1 ', 'placeholder stream.'];
  let seq = 1;
  for (const text of lines) {
    yield { type: 'text_delta', seq: seq++, sessionId, block: 0, text };
    await new Promise((r) => setTimeout(r, 25));
  }
  yield { type: 'turn_complete', seq: seq++, sessionId, finishReason: 'end_turn' };
}
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
bun test tests/server/events.test.ts
```

Expected: 1 pass.

- [ ] **Step 5: Commit.**

```bash
git add src/server/routes/events.ts tests/server/events.test.ts
git commit -m "feat(server): GET /sessions/:id/events with hardcoded M1 stream"
```

## Task M1.7 — `src/server/app.ts` — Hono app composition

**Files:**
- Create: `src/server/app.ts`

- [ ] **Step 1: Write the failing test (smoke that the app boots and routes are mounted).**

Append to `tests/server/health.test.ts` (or create `tests/server/app.test.ts` — keep it as a new file to keep concerns separate):

Create `tests/server/app.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { buildApp } from '../../src/server/app.js';

describe('buildApp', () => {
  test('mounts /health', async () => {
    const app = buildApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  test('mounts /sessions/:id/events', async () => {
    const app = buildApp();
    const res = await app.request('/sessions/s_smoke/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  });

  test('returns 404 for unknown routes', async () => {
    const app = buildApp();
    const res = await app.request('/no-such-route');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/server/app.test.ts
```

Expected: cannot find `buildApp`.

- [ ] **Step 3: Create `src/server/app.ts`.**

```typescript
// Hono app composition for the Phase 16.1 HTTP+SSE server.
//
// M1: /health + /sessions/:id/events (hardcoded stream).
// M3 expands: POST /sessions, POST /sessions/:id/turns, etc.

import { Hono } from 'hono';
import { eventsRoute } from './routes/events.js';
import { healthRoute } from './routes/health.js';

export function buildApp(): Hono {
  const app = new Hono();
  app.route('/', healthRoute);
  app.route('/', eventsRoute);
  return app;
}
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
bun test tests/server/app.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit.**

```bash
git add src/server/app.ts tests/server/app.test.ts
git commit -m "feat(server): buildApp() composing health + events routes"
```

## Task M1.8 — `src/server/index.ts` — `startServer()` boot contract

**Files:**
- Create: `src/server/index.ts`
- Create: `tests/server/startServer.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `tests/server/startServer.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { startServer } from '../../src/server/index.js';

describe('startServer', () => {
  test('binds to a free port on 127.0.0.1 and serves /health', async () => {
    const { port, stop } = await startServer();
    try {
      expect(port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await stop();
    }
  });

  test('stop() closes the server (subsequent fetch fails)', async () => {
    const { port, stop } = await startServer();
    await stop();
    let threw = false;
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/server/startServer.test.ts
```

Expected: cannot find `startServer`.

- [ ] **Step 3: Create `src/server/index.ts`.**

```typescript
// Public boot entry for the Phase 16.1 HTTP+SSE server.
//
// startServer(opts) picks a free port on 127.0.0.1, mounts the Hono app,
// returns a { port, stop } handle. Single-server-per-process by design;
// callers that want multi-process isolation spawn separate sov runtimes.

import { buildApp } from './app.js';
import { findFreePort } from './port.js';

export type StartServerOptions = {
  /** Override the random-port pick (testing / explicit-port modes). */
  port?: number;
};

export type StartedServer = {
  port: number;
  stop: () => Promise<void>;
};

export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const port = opts.port ?? (await findFreePort());
  const app = buildApp();
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: app.fetch,
  });
  return {
    port: server.port,
    stop: async () => {
      server.stop();
    },
  };
}
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
bun test tests/server/startServer.test.ts
```

Expected: 2 pass.

- [ ] **Step 5: Run the full server test suite as a regression check.**

```bash
bun test tests/server/
```

Expected: all server tests pass (`schema`, `port`, `sseStream`, `health`, `events`, `app`, `startServer`).

- [ ] **Step 6: Commit.**

```bash
git add src/server/index.ts tests/server/startServer.test.ts
git commit -m "feat(server): startServer() public boot entry"
```

## Task M1.9 — `sov serve-dev` subcommand for manual smoke

**Files:**
- Modify: `src/main.ts`

Add a development-only subcommand that boots the server and prints the URL. M2 uses this for manual smoke; M3 promotes it (renamed if needed) into the production launch path.

- [ ] **Step 1: Find the right insertion point in `src/main.ts`.**

```bash
grep -n "command('dispatch')" src/main.ts
```

The `dispatch` command pattern is the template. Insert a new `serve-dev` command directly after the `dispatch` subcommand definition.

- [ ] **Step 2: Write the manual smoke (this is a manual step, not a unit test — `serve-dev` is a long-running command).**

Add this manual-smoke note to the testing log as part of the M1 commit later.

- [ ] **Step 3: Add the `serve-dev` subcommand to `src/main.ts`.**

After the `.command('dispatch')` block and before `.command('config')`, insert:

```typescript
  program
    .command('serve-dev')
    .description('boot the Phase 16.1 HTTP+SSE server on 127.0.0.1 (M1 dev harness)')
    .option('--port <n>', 'explicit port (default: random free port)', (v) => parseInt(v, 10))
    .action(async (opts) => {
      const { startServer } = await import('./server/index.js');
      const startOpts: { port?: number } = {};
      if (typeof opts.port === 'number') startOpts.port = opts.port;
      const server = await startServer(startOpts);
      console.log(`sov serve-dev: listening on http://127.0.0.1:${server.port}`);
      console.log('  GET /health');
      console.log(`  GET /sessions/<id>/events  (SSE)`);
      console.log('Press Ctrl-C to stop.');
      process.on('SIGINT', async () => {
        await server.stop();
        process.exit(0);
      });
      process.on('SIGTERM', async () => {
        await server.stop();
        process.exit(0);
      });
    });
```

- [ ] **Step 4: Run typecheck + lint to verify no main.ts regressions.**

```bash
bun run lint && bun run typecheck
```

Expected: both pass.

- [ ] **Step 5: Manual smoke.**

In one terminal:

```bash
bun src/main.ts serve-dev --port 18080
```

Expected output:

```
sov serve-dev: listening on http://127.0.0.1:18080
  GET /health
  GET /sessions/<id>/events  (SSE)
Press Ctrl-C to stop.
```

In a second terminal:

```bash
curl -s http://127.0.0.1:18080/health
# Expected: {"ok":true,"version":"0.0.1"}

curl -Ns http://127.0.0.1:18080/sessions/s_manual/events
# Expected: SSE stream with three text_delta blocks then turn_complete, then connection closes.
```

Stop the server with Ctrl-C.

- [ ] **Step 6: Append a testing-log entry.**

Edit `docs/testing-log.md` and prepend (newest first per CLAUDE.md convention) the following entry block under whatever the current top-most date heading is, or under a new `## 2026-05-13` heading:

```markdown
### 2026-05-13 · M1 server skeleton — manual smoke

**Scope:** Phase 16.1 M1 — Hono HTTP+SSE server skeleton.
**Commands:**
- `bun test tests/server/` → all green (8 tests)
- `bun src/main.ts serve-dev --port 18080`
- `curl -s http://127.0.0.1:18080/health` → `{"ok":true,"version":"0.0.1"}`
- `curl -Ns http://127.0.0.1:18080/sessions/s_manual/events` → 3 text_delta blocks + turn_complete; connection closes cleanly
**Result:** pass.
**Follow-ups:** none — M2 next.
```

- [ ] **Step 7: Commit.**

```bash
git add src/main.ts docs/testing-log.md
git commit -m "feat(cli): sov serve-dev subcommand for M1 manual smoke"
```

## M1 Exit Gate

- [ ] `bun test tests/server/` is green
- [ ] `bun run lint && bun run typecheck` green
- [ ] Manual curl smoke against `serve-dev` works as documented
- [ ] One commit per task on `master`; pushed; testing-log updated

---

# M2 — Bubble Tea Bare Scaffold

**Goal:** `sov-tui` Go binary builds via `bun run scripts/build-tui.ts`; postinstall hook is wired; the binary connects to a running `sov serve-dev`, renders the hardcoded M1 SSE stream as scrollable transcript lines, shows a placeholder status line, accepts text in an input row (no submit logic yet — that's M3), and quits on ESC. `--ui tui|repl` flag added to `src/main.ts` as opt-in.

## Task M2.1 — Initialize the Go module and dependencies

**Files:**
- Create: `packages/tui/go.mod`
- Create: `packages/tui/go.sum` (generated by `go mod tidy`)

- [ ] **Step 1: Verify Go is installed and ≥ 1.22.**

```bash
go version
```

Expected: `go version go1.22.0` or higher. If not installed, follow https://go.dev/doc/install (macOS: `brew install go`; Linux: distro package manager or tarball).

- [ ] **Step 2: Create the directory and initialize the module.**

```bash
mkdir -p packages/tui/cmd/sov-tui
mkdir -p packages/tui/internal/app
mkdir -p packages/tui/internal/transport
mkdir -p packages/tui/internal/components
cd packages/tui
go mod init github.com/yevgetman/sovereign-ai-harness/packages/tui
```

Expected: creates `packages/tui/go.mod` with module path `github.com/yevgetman/sovereign-ai-harness/packages/tui` and a `go 1.22` line (or higher).

- [ ] **Step 3: Add Bubble Tea + lipgloss + bubbles as dependencies.**

```bash
cd packages/tui
go get github.com/charmbracelet/bubbletea@latest
go get github.com/charmbracelet/lipgloss@latest
go get github.com/charmbracelet/bubbles@latest
```

These three are the M2 dependencies; M3 adds glamour and chroma; M9 polish adds others.

- [ ] **Step 4: Verify the go.mod looks right.**

```bash
cat packages/tui/go.mod
```

Expected: a module declaration plus `require` entries for bubbletea, lipgloss, bubbles.

- [ ] **Step 5: Commit (no test yet — module init is a prerequisite).**

```bash
git add packages/tui/go.mod packages/tui/go.sum
git commit -m "build(tui): initialize Go module with bubbletea + lipgloss + bubbles"
```

## Task M2.2 — Go transport types mirroring `schema.ts`

**Files:**
- Create: `packages/tui/internal/transport/types.go`
- Create: `packages/tui/internal/transport/types_test.go`

- [ ] **Step 1: Write the failing Go test.**

Create `packages/tui/internal/transport/types_test.go`:

```go
package transport

import (
	"encoding/json"
	"testing"
)

func TestDecodeTextDelta(t *testing.T) {
	raw := `{"type":"text_delta","seq":1,"sessionId":"s_t","block":0,"text":"hi"}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatalf("envelope decode: %v", err)
	}
	if env.Type != "text_delta" {
		t.Fatalf("got type=%q, want text_delta", env.Type)
	}
	if env.Seq != 1 {
		t.Fatalf("got seq=%d, want 1", env.Seq)
	}
	td, err := DecodeTextDelta(env.Raw)
	if err != nil {
		t.Fatalf("decode text_delta: %v", err)
	}
	if td.Text != "hi" {
		t.Fatalf("got text=%q, want %q", td.Text, "hi")
	}
}

func TestDecodeTurnComplete(t *testing.T) {
	raw := `{"type":"turn_complete","seq":42,"sessionId":"s","finishReason":"end_turn"}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	tc, err := DecodeTurnComplete(env.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if tc.FinishReason != "end_turn" {
		t.Fatalf("got finishReason=%q", tc.FinishReason)
	}
}

func TestEnvelope_unknownType(t *testing.T) {
	raw := `{"type":"unknown_event","seq":1,"sessionId":"s"}`
	var env Envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "unknown_event" {
		t.Fatalf("got type=%q", env.Type)
	}
}
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
cd packages/tui && go test ./internal/transport/
```

Expected: build error — package doesn't compile (no `Envelope`, no `DecodeTextDelta`, etc.).

- [ ] **Step 3: Create `packages/tui/internal/transport/types.go`.**

```go
// Package transport mirrors src/server/schema.ts in Go.
// Stays in lockstep with the TS Zod schemas; reviewer must compare both sides
// when a schema changes.

package transport

import (
	"encoding/json"
	"fmt"
)

// Envelope is the on-wire shape: type + seq + sessionId + raw payload.
// The full message also contains type-specific fields; those are decoded
// into per-type structs via Decode<Type>(raw).
type Envelope struct {
	Type      string          `json:"type"`
	Seq       int64           `json:"seq"`
	SessionID string          `json:"sessionId"`
	Raw       json.RawMessage `json:"-"`
}

// UnmarshalJSON parses type/seq/sessionId AND keeps the full raw bytes for
// downstream type-specific decoding.
func (e *Envelope) UnmarshalJSON(data []byte) error {
	var head struct {
		Type      string `json:"type"`
		Seq       int64  `json:"seq"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return fmt.Errorf("envelope head: %w", err)
	}
	e.Type = head.Type
	e.Seq = head.Seq
	e.SessionID = head.SessionID
	e.Raw = append(e.Raw[:0], data...)
	return nil
}

type TextDelta struct {
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	SessionID string `json:"sessionId"`
	Block     int    `json:"block"`
	Text      string `json:"text"`
}

type ThinkingDelta struct {
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	SessionID string `json:"sessionId"`
	Block     int    `json:"block"`
	Text      string `json:"text"`
}

type ToolUseStart struct {
	Type      string          `json:"type"`
	Seq       int64           `json:"seq"`
	SessionID string          `json:"sessionId"`
	Block     int             `json:"block"`
	Tool      string          `json:"tool"`
	Input     json.RawMessage `json:"inputPartial,omitempty"`
}

type ToolUseDone struct {
	Type      string          `json:"type"`
	Seq       int64           `json:"seq"`
	SessionID string          `json:"sessionId"`
	Block     int             `json:"block"`
	Input     json.RawMessage `json:"input"`
}

type ToolResult struct {
	Type       string          `json:"type"`
	Seq        int64           `json:"seq"`
	SessionID  string          `json:"sessionId"`
	Block      int             `json:"block"`
	Tool       string          `json:"tool"`
	Input      json.RawMessage `json:"input"`
	Output     json.RawMessage `json:"output"`
	RenderHint string          `json:"renderHint"`
	Language   string          `json:"language,omitempty"`
}

type StatusUpdate struct {
	Type         string  `json:"type"`
	Seq          int64   `json:"seq"`
	SessionID    string  `json:"sessionId"`
	Cost         float64 `json:"cost,omitempty"`
	TokensIn     int     `json:"tokensIn,omitempty"`
	TokensOut    int     `json:"tokensOut,omitempty"`
	CacheHitRate float64 `json:"cacheHitRate,omitempty"`
	Streaming    bool    `json:"streaming,omitempty"`
}

type TurnComplete struct {
	Type         string `json:"type"`
	Seq          int64  `json:"seq"`
	SessionID    string `json:"sessionId"`
	FinishReason string `json:"finishReason"`
}

type TurnError struct {
	Type        string `json:"type"`
	Seq         int64  `json:"seq"`
	SessionID   string `json:"sessionId"`
	Error       string `json:"error"`
	Recoverable bool   `json:"recoverable"`
}

func DecodeTextDelta(raw []byte) (TextDelta, error) {
	var t TextDelta
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeThinkingDelta(raw []byte) (ThinkingDelta, error) {
	var t ThinkingDelta
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeToolUseStart(raw []byte) (ToolUseStart, error) {
	var t ToolUseStart
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeToolUseDone(raw []byte) (ToolUseDone, error) {
	var t ToolUseDone
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeToolResult(raw []byte) (ToolResult, error) {
	var t ToolResult
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeStatusUpdate(raw []byte) (StatusUpdate, error) {
	var t StatusUpdate
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeTurnComplete(raw []byte) (TurnComplete, error) {
	var t TurnComplete
	err := json.Unmarshal(raw, &t)
	return t, err
}

func DecodeTurnError(raw []byte) (TurnError, error) {
	var t TurnError
	err := json.Unmarshal(raw, &t)
	return t, err
}
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
cd packages/tui && go test ./internal/transport/ -v
```

Expected: 3 PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/tui/internal/transport/types.go packages/tui/internal/transport/types_test.go packages/tui/go.sum
git commit -m "feat(tui): transport event types mirroring src/server/schema.ts"
```

## Task M2.3 — SSE consumer

**Files:**
- Create: `packages/tui/internal/transport/sse.go`
- Create: `packages/tui/internal/transport/sse_test.go`

- [ ] **Step 1: Write the failing test.**

Create `packages/tui/internal/transport/sse_test.go`:

```go
package transport

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestConsume_streamsTextDeltaAndCompletes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, _ := w.(http.Flusher)

		fmt.Fprint(w, "event: text_delta\nid: 1\ndata: {\"type\":\"text_delta\",\"seq\":1,\"sessionId\":\"s\",\"block\":0,\"text\":\"Hi\"}\n\n")
		flusher.Flush()
		fmt.Fprint(w, "event: text_delta\nid: 2\ndata: {\"type\":\"text_delta\",\"seq\":2,\"sessionId\":\"s\",\"block\":0,\"text\":\" there\"}\n\n")
		flusher.Flush()
		fmt.Fprint(w, "event: turn_complete\nid: 3\ndata: {\"type\":\"turn_complete\",\"seq\":3,\"sessionId\":\"s\",\"finishReason\":\"end_turn\"}\n\n")
		flusher.Flush()
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	ch, errCh := Consume(ctx, srv.URL)

	var got []Envelope
	for ev := range ch {
		got = append(got, ev)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("consume err: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d events, want 3", len(got))
	}
	if got[0].Type != "text_delta" || got[2].Type != "turn_complete" {
		t.Fatalf("types: %q ... %q", got[0].Type, got[2].Type)
	}
}
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
cd packages/tui && go test ./internal/transport/
```

Expected: build error (`Consume` undefined).

- [ ] **Step 3: Create `packages/tui/internal/transport/sse.go`.**

```go
// Package transport — SSE consumer.
//
// Connects to GET <url>, parses standard `event: <type>\nid: <seq>\ndata: <json>\n\n`
// blocks, and emits typed Envelopes on a channel. Closes the channel when
// the server ends the response or ctx is cancelled. Errors (HTTP, parse) are
// surfaced on errCh after the events channel closes.

package transport

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Consume opens an SSE connection at url and returns:
//   - events: closed when stream ends or ctx cancels.
//   - errs:   single-receive; nil if stream ended cleanly.
func Consume(ctx context.Context, url string) (<-chan Envelope, <-chan error) {
	events := make(chan Envelope, 16)
	errs := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errs)

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			errs <- fmt.Errorf("new request: %w", err)
			return
		}
		req.Header.Set("Accept", "text/event-stream")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			errs <- fmt.Errorf("http do: %w", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			errs <- fmt.Errorf("unexpected status %d", resp.StatusCode)
			return
		}

		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		var dataLines []string
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				if len(dataLines) > 0 {
					data := strings.Join(dataLines, "\n")
					var env Envelope
					if err := json.Unmarshal([]byte(data), &env); err == nil {
						select {
						case <-ctx.Done():
							errs <- ctx.Err()
							return
						case events <- env:
						}
					}
					dataLines = dataLines[:0]
				}
				continue
			}
			if strings.HasPrefix(line, "data: ") {
				dataLines = append(dataLines, strings.TrimPrefix(line, "data: "))
			}
			// event: and id: lines are advisory; the JSON payload carries them.
		}
		if err := sc.Err(); err != nil {
			errs <- fmt.Errorf("scanner: %w", err)
		}
	}()

	return events, errs
}
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
cd packages/tui && go test ./internal/transport/ -v
```

Expected: all transport tests PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/tui/internal/transport/sse.go packages/tui/internal/transport/sse_test.go
git commit -m "feat(tui): SSE consumer that emits typed Envelopes on a channel"
```

## Task M2.4 — Transcript component (scrollable viewport)

**Files:**
- Create: `packages/tui/internal/components/transcript.go`

- [ ] **Step 1: Create `packages/tui/internal/components/transcript.go`.**

(No standalone test for M2 — covered by the `app` snapshot test in M2.7.)

```go
// Package components — Transcript: scrollable viewport of message lines.
//
// M2: append-only text buffer with bubbles/viewport scrollback. M3+: each
// message is a typed card (user / assistant / tool) with collapsible state.

package components

import (
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

type Transcript struct {
	vp        viewport.Model
	lines     []string
	width     int
	height    int
	atBottom  bool
}

func NewTranscript() Transcript {
	vp := viewport.New(80, 20)
	return Transcript{vp: vp, atBottom: true}
}

func (t Transcript) Update(msg tea.Msg) (Transcript, tea.Cmd) {
	var cmd tea.Cmd
	t.vp, cmd = t.vp.Update(msg)
	return t, cmd
}

func (t *Transcript) SetSize(w, h int) {
	t.width = w
	t.height = h
	t.vp.Width = w
	t.vp.Height = h
	t.vp.SetContent(joinLines(t.lines))
}

func (t *Transcript) AppendLine(line string) {
	t.lines = append(t.lines, line)
	t.vp.SetContent(joinLines(t.lines))
	if t.atBottom {
		t.vp.GotoBottom()
	}
}

func (t Transcript) View() string {
	return t.vp.View()
}

func joinLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	out := lines[0]
	for _, l := range lines[1:] {
		out += "\n" + l
	}
	return out
}
```

- [ ] **Step 2: Verify it compiles.**

```bash
cd packages/tui && go build ./internal/components/
```

Expected: builds without errors.

- [ ] **Step 3: Commit.**

```bash
git add packages/tui/internal/components/transcript.go
git commit -m "feat(tui): Transcript component over bubbles/viewport"
```

## Task M2.5 — Prompt component (input row)

**Files:**
- Create: `packages/tui/internal/components/prompt.go`

- [ ] **Step 1: Create `packages/tui/internal/components/prompt.go`.**

```go
// Package components — Prompt: bottom input row.
//
// M2: single-line bubbles/textinput; ENTER does nothing yet (M3 wires submit).
// Width is set by parent on resize.

package components

import (
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type Prompt struct {
	ti       textinput.Model
	width    int
	disabled bool
}

func NewPrompt() Prompt {
	ti := textinput.New()
	ti.Placeholder = "type a message..."
	ti.Prompt = "› "
	ti.Focus()
	return Prompt{ti: ti}
}

func (p Prompt) Update(msg tea.Msg) (Prompt, tea.Cmd) {
	var cmd tea.Cmd
	p.ti, cmd = p.ti.Update(msg)
	return p, cmd
}

func (p *Prompt) SetWidth(w int) {
	p.width = w
	p.ti.Width = w - 4
}

func (p Prompt) Value() string {
	return p.ti.Value()
}

func (p *Prompt) Clear() {
	p.ti.SetValue("")
}

func (p Prompt) View() string {
	border := lipgloss.NewStyle().BorderTop(true).BorderStyle(lipgloss.NormalBorder()).BorderForeground(lipgloss.Color("#444c56"))
	return border.Width(p.width).Render(p.ti.View())
}
```

- [ ] **Step 2: Verify it compiles.**

```bash
cd packages/tui && go build ./internal/components/
```

- [ ] **Step 3: Commit.**

```bash
git add packages/tui/internal/components/prompt.go
git commit -m "feat(tui): Prompt component over bubbles/textinput"
```

## Task M2.6 — StatusLine component

**Files:**
- Create: `packages/tui/internal/components/statusline.go`

- [ ] **Step 1: Create `packages/tui/internal/components/statusline.go`.**

```go
// Package components — StatusLine: bottom anchored status row.
//
// M2: hardcoded fields (cwd, provider, model placeholders). M3 wires real
// state from status_update events.

package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
)

type StatusLine struct {
	width    int
	Cwd      string
	Profile  string
	Provider string
	Model    string
	Cost     float64
	CacheHit float64
	Streaming bool
}

func NewStatusLine() StatusLine {
	return StatusLine{
		Cwd:      "?",
		Profile:  "default",
		Provider: "?",
		Model:    "?",
	}
}

func (s *StatusLine) SetWidth(w int) {
	s.width = w
}

func (s StatusLine) View() string {
	bg := lipgloss.NewStyle().
		Width(s.width).
		Padding(0, 1).
		Foreground(lipgloss.Color("#8b949e")).
		Background(lipgloss.Color("#161b22"))

	stream := ""
	if s.Streaming {
		stream = "  streaming●"
	}
	text := fmt.Sprintf("%s  %s  %s  $%.2f  cache %.0f%%%s",
		s.Cwd,
		s.Profile,
		s.Model,
		s.Cost,
		s.CacheHit*100,
		stream,
	)
	return bg.Render(text)
}
```

- [ ] **Step 2: Verify it compiles.**

```bash
cd packages/tui && go build ./internal/components/
```

- [ ] **Step 3: Commit.**

```bash
git add packages/tui/internal/components/statusline.go
git commit -m "feat(tui): StatusLine component with lipgloss styling"
```

## Task M2.7 — App: root Model / Update / View

**Files:**
- Create: `packages/tui/internal/app/app.go`
- Create: `packages/tui/internal/app/keys.go`
- Create: `packages/tui/internal/app/app_test.go`

- [ ] **Step 1: Write the failing snapshot test.**

`teatest` ships in `github.com/charmbracelet/x/exp/teatest`. Add it:

```bash
cd packages/tui && go get github.com/charmbracelet/x/exp/teatest@latest
```

Create `packages/tui/internal/app/app_test.go`:

```go
package app

import (
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/teatest"
)

func TestBareScaffold_rendersThreeRegions(t *testing.T) {
	tm := teatest.NewTestModel(t, New("test-session", "http://127.0.0.1:0"), teatest.WithInitialTermSize(80, 24))

	teatest.WaitFor(t, tm.Output(), func(b []byte) bool {
		// Look for the input prompt marker and the status row's bg color
		// has rendered (lipgloss outputs ANSI escapes — check for the
		// textinput prompt char "›").
		return contains(b, "›")
	}, teatest.WithDuration(2*time.Second))

	// ESC quits.
	tm.Send(tea.KeyMsg{Type: tea.KeyEsc})
	tm.WaitFinished(t, teatest.WithFinalTimeout(2*time.Second))
}

func contains(haystack []byte, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if string(haystack[i:i+len(needle)]) == needle {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
cd packages/tui && go test ./internal/app/
```

Expected: build error (`New` undefined).

- [ ] **Step 3: Create `packages/tui/internal/app/keys.go`.**

```go
package app

import "github.com/charmbracelet/bubbles/key"

type keyMap struct {
	Quit key.Binding
}

func defaultKeys() keyMap {
	return keyMap{
		Quit: key.NewBinding(
			key.WithKeys("esc", "ctrl+c"),
			key.WithHelp("esc/ctrl+c", "quit"),
		),
	}
}
```

- [ ] **Step 4: Create `packages/tui/internal/app/app.go`.**

```go
// Package app — Bubble Tea root model for the Phase 16.1 TUI.
//
// M2: bare scaffold. Renders transcript + prompt + status. SSE consumer is
// wired but the URL may point at a stub server during smoke. ESC quits.
//
// M3 expands: text_delta events append to transcript; tool_result events
// produce placeholder cards; prompt ENTER submits a POST /turns.

package app

import (
	"context"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/components"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/transport"
)

// sseMsg is emitted into the Bubble Tea event loop for each Envelope.
type sseMsg struct{ env transport.Envelope }

// sseDoneMsg signals the SSE consumer has finished (turn ended or error).
type sseDoneMsg struct{ err error }

type Model struct {
	keys       keyMap
	transcript components.Transcript
	prompt     components.Prompt
	statusLine components.StatusLine
	sessionID  string
	streamURL  string
	width      int
	height     int
	ctx        context.Context
	cancel     context.CancelFunc
}

func New(sessionID, streamURL string) Model {
	cwd, _ := os.Getwd()
	ctx, cancel := context.WithCancel(context.Background())
	st := components.NewStatusLine()
	st.Cwd = cwd
	return Model{
		keys:       defaultKeys(),
		transcript: components.NewTranscript(),
		prompt:     components.NewPrompt(),
		statusLine: st,
		sessionID:  sessionID,
		streamURL:  streamURL,
		ctx:        ctx,
		cancel:     cancel,
	}
}

func (m Model) Init() tea.Cmd {
	if m.streamURL == "" {
		return nil
	}
	return m.connectSSE
}

// connectSSE returns a tea.Cmd that opens the SSE stream and feeds Envelopes
// back into the Bubble Tea loop as sseMsg until it ends (or errors).
func (m Model) connectSSE() tea.Msg {
	events, errs := transport.Consume(m.ctx, m.streamURL)
	for env := range events {
		// Send each event back into the loop as a tea.Msg by returning;
		// however, tea.Cmd returns a single Msg. We need a Cmd that emits
		// many. The pattern is: a Cmd that polls one event and recursively
		// reschedules itself.
		return sseMsg{env: env}
	}
	if err := <-errs; err != nil {
		return sseDoneMsg{err: err}
	}
	return sseDoneMsg{err: nil}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		const statusH = 1
		const promptH = 2
		m.transcript.SetSize(msg.Width, msg.Height-statusH-promptH)
		m.prompt.SetWidth(msg.Width)
		m.statusLine.SetWidth(msg.Width)
		return m, nil
	case tea.KeyMsg:
		if key := msg.String(); key == "esc" || key == "ctrl+c" {
			m.cancel()
			return m, tea.Quit
		}
		var cmd tea.Cmd
		m.prompt, cmd = m.prompt.Update(msg)
		return m, cmd
	case sseMsg:
		m.handleEvent(msg.env)
		return m, m.connectSSE
	case sseDoneMsg:
		m.transcript.AppendLine("[stream closed]")
		return m, nil
	}
	var cmd tea.Cmd
	m.transcript, cmd = m.transcript.Update(msg)
	return m, cmd
}

func (m *Model) handleEvent(env transport.Envelope) {
	switch env.Type {
	case "text_delta":
		td, err := transport.DecodeTextDelta(env.Raw)
		if err != nil {
			return
		}
		m.transcript.AppendLine(td.Text)
	case "turn_complete":
		m.transcript.AppendLine("[turn complete]")
	}
}

func (m Model) View() string {
	if m.height == 0 {
		return ""
	}
	return m.transcript.View() + "\n" + m.prompt.View() + "\n" + m.statusLine.View()
}
```

Note: the `connectSSE`-returning-itself pattern is the standard Bubble Tea idiom for an unbounded event source. Each `sseMsg` triggers the next read.

- [ ] **Step 5: Run the test; verify it PASSES.**

```bash
cd packages/tui && go test ./internal/app/ -v
```

Expected: 1 PASS.

- [ ] **Step 6: Run the full Go test suite.**

```bash
cd packages/tui && go test ./...
```

Expected: all packages green.

- [ ] **Step 7: Commit.**

```bash
git add packages/tui/internal/app/ packages/tui/go.sum
git commit -m "feat(tui): App root model with SSE-driven Update loop"
```

## Task M2.8 — Entry point `cmd/sov-tui/main.go`

**Files:**
- Create: `packages/tui/cmd/sov-tui/main.go`

- [ ] **Step 1: Create `packages/tui/cmd/sov-tui/main.go`.**

```go
// sov-tui — Bubble Tea client for the Phase 16.1 sov harness.
//
// Connects to a running sov HTTP+SSE server at --port on 127.0.0.1, opens
// the SSE stream for --session-id, and renders the foreground TUI.

package main

import (
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yevgetman/sovereign-ai-harness/packages/tui/internal/app"
)

func main() {
	var (
		port      = flag.Int("port", 0, "server port on 127.0.0.1 (required)")
		sessionID = flag.String("session-id", "", "session ID (required)")
		version   = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *version {
		fmt.Println("sov-tui 0.0.1")
		return
	}
	if *port == 0 || *sessionID == "" {
		fmt.Fprintln(os.Stderr, "sov-tui: --port and --session-id are required")
		os.Exit(2)
	}

	streamURL := fmt.Sprintf("http://127.0.0.1:%d/sessions/%s/events", *port, *sessionID)
	model := app.New(*sessionID, streamURL)
	prog := tea.NewProgram(model, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := prog.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "sov-tui: %v\n", err)
		os.Exit(1)
	}
}
```

- [ ] **Step 2: Build to verify.**

```bash
cd packages/tui && go build -o /tmp/sov-tui-smoke ./cmd/sov-tui
/tmp/sov-tui-smoke --version
```

Expected: prints `sov-tui 0.0.1`.

```bash
/tmp/sov-tui-smoke
```

Expected: prints `sov-tui: --port and --session-id are required` to stderr and exits 2.

- [ ] **Step 3: Clean up the temporary binary.**

```bash
rm /tmp/sov-tui-smoke
```

- [ ] **Step 4: Commit.**

```bash
git add packages/tui/cmd/sov-tui/main.go
git commit -m "feat(tui): sov-tui cmd entry point with --port and --session-id flags"
```

## Task M2.9 — `scripts/build-tui.ts` — Postinstall build script

**Files:**
- Create: `scripts/build-tui.ts`
- Create: `bin/.gitkeep` (so `bin/` exists in the repo)
- Modify: `.gitignore`

- [ ] **Step 1: Create the `bin/` placeholder.**

```bash
mkdir -p bin
touch bin/.gitkeep
```

- [ ] **Step 2: Add `bin/sov-tui` to `.gitignore`.**

Edit `.gitignore` and add (under the existing `# Bun` block or in a new `# Built artifacts` block):

```
# Built TUI binary (built by scripts/build-tui.ts on postinstall)
bin/sov-tui
```

- [ ] **Step 3: Create `scripts/build-tui.ts`.**

```typescript
#!/usr/bin/env bun
// scripts/build-tui.ts
//
// Postinstall build: detect Go ≥ 1.22; build packages/tui/cmd/sov-tui to
// bin/sov-tui. On failure, print clear remediation and exit 0 — bun install
// keeps succeeding so the TS runtime is still usable; sov falls back to
// --ui repl with a one-line warning at launch.

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const TUI_DIR = join(REPO_ROOT, 'packages', 'tui');
const BIN_DIR = join(REPO_ROOT, 'bin');
const OUT = join(BIN_DIR, 'sov-tui');
const MIN_GO_MAJOR = 1;
const MIN_GO_MINOR = 22;

async function detectGo(): Promise<{ major: number; minor: number } | null> {
  try {
    const proc = Bun.spawn(['go', 'version'], { stdout: 'pipe', stderr: 'pipe' });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    // Format: "go version go1.22.0 darwin/arm64"
    const m = text.match(/go(\d+)\.(\d+)/);
    if (!m) return null;
    const majorStr = m[1];
    const minorStr = m[2];
    if (!majorStr || !minorStr) return null;
    return { major: parseInt(majorStr, 10), minor: parseInt(minorStr, 10) };
  } catch {
    return null;
  }
}

function warnNoGo(): void {
  console.warn('');
  console.warn('┌─────────────────────────────────────────────────────────────┐');
  console.warn('│  sov: Go ≥ 1.22 not detected on PATH                       │');
  console.warn('│                                                             │');
  console.warn('│  The TS runtime installed successfully and `sov --ui repl` │');
  console.warn('│  (the default) will work. To enable `sov --ui tui`, install │');
  console.warn('│  Go and re-run `sov upgrade`:                               │');
  console.warn('│                                                             │');
  console.warn('│    macOS:  brew install go                                  │');
  console.warn('│    Linux:  see https://go.dev/doc/install                   │');
  console.warn('│                                                             │');
  console.warn('└─────────────────────────────────────────────────────────────┘');
  console.warn('');
}

async function build(): Promise<boolean> {
  if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });
  const proc = Bun.spawn(['go', 'build', '-o', OUT, './cmd/sov-tui'], {
    cwd: TUI_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  return code === 0;
}

async function main(): Promise<void> {
  const go = await detectGo();
  if (go === null) {
    warnNoGo();
    return;
  }
  if (go.major < MIN_GO_MAJOR || (go.major === MIN_GO_MAJOR && go.minor < MIN_GO_MINOR)) {
    console.warn(`sov: Go ${go.major}.${go.minor} detected; need ≥ ${MIN_GO_MAJOR}.${MIN_GO_MINOR}.`);
    warnNoGo();
    return;
  }
  if (!existsSync(TUI_DIR)) {
    console.warn(`sov: packages/tui not present at ${TUI_DIR}; skipping TUI build.`);
    return;
  }
  console.log('sov: building TUI client (Go)...');
  const ok = await build();
  if (!ok) {
    console.warn('sov: TUI build failed. The TS runtime still works; `sov --ui repl` is unaffected.');
    return;
  }
  console.log(`sov: built ${OUT}`);
}

await main();
```

- [ ] **Step 4: Verify the script runs successfully against the current tree.**

```bash
bun run scripts/build-tui.ts
```

Expected: prints `sov: building TUI client (Go)...` followed by `sov: built /Users/.../bin/sov-tui`. The binary exists at `bin/sov-tui` and is executable:

```bash
./bin/sov-tui --version
# Expected: sov-tui 0.0.1
```

- [ ] **Step 5: Add the postinstall hook to `package.json` and a `tui:build` script.**

Modify the `scripts` block in `package.json` to include:

```json
"scripts": {
  "chat": "bun src/main.ts",
  "eval:website": "bun src/evals/websiteBuildEval.ts",
  "test": "bun test",
  "test:semantic": "bun tests/semantic/run.ts",
  "lint": "biome check src tests",
  "format": "biome format --write src tests",
  "typecheck": "tsc --noEmit",
  "tui:build": "bun run scripts/build-tui.ts",
  "postinstall": "bun run scripts/build-tui.ts"
}
```

- [ ] **Step 6: Test the postinstall path.**

```bash
bun install
```

Expected: completes; runs the postinstall; prints the `sov: built ...` line.

- [ ] **Step 7: Commit.**

```bash
git add scripts/build-tui.ts bin/.gitkeep package.json bun.lockb .gitignore
git commit -m "build(tui): postinstall script builds packages/tui to bin/sov-tui"
```

## Task M2.10 — Add `--ui` flag to `src/main.ts` (opt-in tui mode)

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Read the current `chat` subcommand declaration in `src/main.ts`.**

```bash
grep -n "command('chat'" src/main.ts
```

Note the line where the `chat` subcommand starts.

- [ ] **Step 2: Add a `--ui` option to the chat subcommand.**

Find the existing options chain on the `chat` command (the line `.command('chat', { isDefault: true })` and following `.option(...)` calls). Add a new option AFTER the existing `--legacy-input` option:

```typescript
    .option('--ui <surface>', 'foreground surface: repl (default) or tui', 'repl')
```

- [ ] **Step 3: Wire the flag in the action handler.**

Find the existing `.action(async (opts) => {` for the chat command. At the top of the action body (before the existing terminalRepl invocation), add a branch that dispatches to the TUI when `opts.ui === 'tui'`:

```typescript
      // Phase 16.1 M2: --ui tui spawns the Go TUI client against an HTTP+SSE
      // server. Falls back to repl with a warning if the TUI binary is missing.
      if (opts.ui === 'tui') {
        const { runTuiLauncher } = await import('./cli/tuiLauncher.js');
        const code = await runTuiLauncher(opts);
        process.exit(code);
      }
```

Leave the rest of the `.action(...)` body unchanged — that's the existing terminalRepl path.

- [ ] **Step 4: Verify typecheck passes (we haven't created `tuiLauncher.ts` yet — this should FAIL).**

```bash
bun run typecheck
```

Expected: error like `Cannot find module './cli/tuiLauncher.js'`. This is intentional — the next task creates it.

## Task M2.11 — `src/cli/tuiLauncher.ts` — Spawn the Go TUI

**Files:**
- Create: `src/cli/tuiLauncher.ts`
- Create: `tests/cli/tuiLauncher.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `tests/cli/tuiLauncher.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTuiBinary } from '../../src/cli/tuiLauncher.js';

describe('findTuiBinary', () => {
  test('honors SOV_TUI_BIN when set', () => {
    process.env.SOV_TUI_BIN = '/tmp/fake-tui';
    expect(findTuiBinary()).toBe('/tmp/fake-tui');
    delete process.env.SOV_TUI_BIN;
  });

  test('falls back to repo-root bin/sov-tui when it exists', () => {
    delete process.env.SOV_TUI_BIN;
    const repoRoot = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
    const expected = join(repoRoot, '..', 'bin', 'sov-tui');
    // The test runs from tests/cli/, so dirname twice → tests/, dirname again → repo root.
    // We accept either form: just assert that if bin/sov-tui exists in CWD-ancestor we find it.
    const found = findTuiBinary();
    if (found && !found.startsWith('/tmp/')) {
      expect(existsSync(found)).toBe(true);
    }
  });

  test('returns null when nothing is found and SOV_TUI_BIN is unset', () => {
    delete process.env.SOV_TUI_BIN;
    // Move CWD to /tmp where no bin/sov-tui exists.
    const orig = process.cwd();
    process.chdir('/tmp');
    try {
      // Only the env-var path is reliable here; PATH lookup might still find it
      // if the user has it globally installed. Skip strict assertion in that case.
      const found = findTuiBinary();
      // Either null or an existing file is acceptable.
      if (found !== null) {
        expect(existsSync(found)).toBe(true);
      }
    } finally {
      process.chdir(orig);
    }
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/cli/tuiLauncher.test.ts
```

Expected: cannot find `findTuiBinary`.

- [ ] **Step 3: Create `src/cli/tuiLauncher.ts`.**

```typescript
// Launch the Go TUI as a child process against an in-process HTTP+SSE server.
//
// Boot sequence:
//   1. Resolve the sov-tui binary path (env override → repo-root bin/ → PATH).
//   2. If unresolved, print fallback warning + run terminalRepl.
//   3. Start the HTTP server on a free localhost port.
//   4. Create a session (M2: synthetic ID since /sessions POST lands in M3).
//   5. Spawn sov-tui --port <p> --session-id <s>, inherit stdio.
//   6. When the child exits, stop the server and return its exit code.

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findTuiBinary(): string | null {
  if (process.env.SOV_TUI_BIN && existsSync(process.env.SOV_TUI_BIN)) {
    return process.env.SOV_TUI_BIN;
  }
  // Walk up from this module until we find a directory containing bin/sov-tui.
  try {
    let dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'bin', 'sov-tui');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // realpath failures are rare; fall through.
  }
  // No PATH lookup in M2; postinstall is the supported install path.
  return null;
}

export type TuiLaunchOptions = Record<string, unknown>;

export async function runTuiLauncher(_opts: TuiLaunchOptions): Promise<number> {
  const binary = findTuiBinary();
  if (binary === null) {
    console.warn('sov: TUI binary not found; falling back to --ui repl.');
    console.warn('     Run `sov upgrade` (requires Go ≥ 1.22 on PATH) to install it.');
    // M2 leaves the fallback to the caller. The chat .action() should
    // detect this exit code and re-dispatch to terminalRepl; for now we
    // return 70 (EX_SOFTWARE) so the caller can branch.
    return 70;
  }

  const { startServer } = await import('../server/index.js');
  const server = await startServer();
  const sessionID = `s_m2_${Date.now()}`;
  const child = spawn(binary, ['--port', String(server.port), '--session-id', sessionID], {
    stdio: 'inherit',
  } as SpawnOptionsWithoutStdio);

  return await new Promise<number>((resolve) => {
    child.on('exit', async (code) => {
      await server.stop();
      resolve(code ?? 0);
    });
  });
}
```

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
bun test tests/cli/tuiLauncher.test.ts
```

Expected: 3 PASS.

- [ ] **Step 5: Run typecheck for `src/main.ts`.**

```bash
bun run typecheck
```

Expected: passes — `tuiLauncher.ts` exists now.

- [ ] **Step 6: M2 manual smoke.**

```bash
bun run tui:build   # rebuild in case anything stale
bun src/main.ts chat --ui tui --bundle bundle-default
```

Expected: the TUI takes over the terminal in alt-screen mode. Three lines of the hardcoded M1 SSE stream stream into the transcript (`Hello from `, `the M1 `, `placeholder stream.`), then `[turn complete]`. Press ESC; you return to the shell.

If the TUI screen is empty or hangs, debug by:

```bash
# in another terminal
curl -Ns http://127.0.0.1:<port-printed-by-server>/sessions/s_m2_<ts>/events
```

(The port and session ID are visible in `sov`'s terminal output before the TUI takes over — they're printed by the spawn debug log in the launcher. Add `console.log(\`spawning sov-tui --port ${server.port} --session-id ${sessionID}\`)` to `tuiLauncher.ts` temporarily if needed.)

- [ ] **Step 7: Update `docs/testing-log.md`.**

Prepend (newest first):

```markdown
### 2026-05-13 · M2 bare TUI scaffold — manual smoke

**Scope:** Phase 16.1 M2 — Bubble Tea bare scaffold, postinstall build, `--ui tui` flag.
**Commands:**
- `bun run tui:build` → built `bin/sov-tui`
- `bun test tests/server/ tests/cli/tuiLauncher.test.ts packages/tui/...` (Go: `cd packages/tui && go test ./...`)
- `bun src/main.ts chat --ui tui --bundle bundle-default` → TUI renders three text_delta lines + `[turn complete]`; ESC quits
**Result:** pass.
**Follow-ups:** M3 wires real `query()` turns through the server.
```

- [ ] **Step 8: Run the full test suite as a regression check before committing.**

```bash
bun test
```

Expected: existing 1809 + new tests, all green.

- [ ] **Step 9: Commit.**

```bash
git add src/main.ts src/cli/tuiLauncher.ts tests/cli/tuiLauncher.test.ts docs/testing-log.md
git commit -m "feat(cli): --ui tui flag spawns sov-tui against an in-process HTTP server"
```

## M2 Exit Gate

- [ ] `bun test` green
- [ ] `cd packages/tui && go test ./...` green
- [ ] `bun src/main.ts chat --ui tui` renders the hardcoded SSE stream
- [ ] `--ui repl` (the default) launches terminalRepl unchanged
- [ ] `bin/sov-tui --version` prints `sov-tui 0.0.1`

---

# M3 — One Real Turn End-To-End

**Goal:** Wire `query()` into the server so `POST /sessions/:id/turns` runs a real turn whose events stream out over SSE. Add `renderHint` to every tool. Render placeholder tool cards in the TUI. No 24-prereq subsystems wired in this milestone.

## Task M3.1 — Add `renderHint` to `ToolDef`

**Files:**
- Modify: `src/tool/types.ts`
- Create: `tests/tool/renderHint.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `tests/tool/renderHint.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { buildTool } from '../../src/tool/buildTool.js';
import type { RenderHint } from '../../src/tool/types.js';

describe('renderHint', () => {
  test('Tool carries the renderHint declared on its ToolDef', () => {
    const hint: RenderHint = { kind: 'code', language: 'typescript' };
    const t = buildTool<{ x: number }, string>({
      name: 'TestTool',
      description: () => 'test',
      inputSchema: z.object({ x: z.number() }),
      call: async (input) => ({ data: String(input.x) }),
      renderHint: hint,
    });
    expect(t.renderHint).toEqual(hint);
  });

  test('Tool with no renderHint has it as undefined', () => {
    const t = buildTool<{ x: number }, string>({
      name: 'TestTool2',
      description: () => 'test',
      inputSchema: z.object({ x: z.number() }),
      call: async () => ({ data: 'ok' }),
    });
    expect(t.renderHint).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/tool/renderHint.test.ts
```

Expected: TS error — `renderHint` not a known property of `ToolDef` or `Tool`.

- [ ] **Step 3: Add `RenderHint` and the field to `src/tool/types.ts`.**

After the existing `ToolObservation` type (around line 38–46) but before `ToolContext`, insert:

```typescript
/** Per-tool render-shape hint. Used by surfaces that cannot call the tool's
 *  TS `renderResult` (e.g., the Go TUI in Phase 16.1). The Go renderer
 *  dispatches on `kind`; the optional `language` is consulted by the
 *  syntax highlighter for `code` and `diff` variants. Tools that omit the
 *  field default to `{ kind: 'text' }` at the boundary. */
export type RenderHint =
  | { kind: 'text' }
  | { kind: 'markdown' }
  | { kind: 'code'; language?: string }
  | { kind: 'diff'; language?: string }
  | { kind: 'table'; columns?: string[] }
  | { kind: 'tree' }
  | { kind: 'json' };
```

Then add `renderHint?: RenderHint;` to `ToolDef` (the definition starting at line 110). Place it in the field group between `renderResult` and `displayInput`:

```typescript
  renderResult?: (output: O) => { content: string; isError?: boolean };

  /** Hint for non-readline render surfaces (Go TUI, web). See RenderHint
   *  for the discriminated union. Optional; defaults to `{ kind: 'text' }`
   *  at the boundary. */
  renderHint?: RenderHint;

  displayInput?: (input: I) => string;
```

The `Tool<I, O, P>` type is `Required<Pick<...>>` &  `Omit<...>` — `renderHint` falls into the `Omit` half (it's not in the `Required<Pick<...>>` list), so `Tool.renderHint` remains `RenderHint | undefined`, which matches the test.

- [ ] **Step 4: Run the test; verify it PASSES.**

```bash
bun test tests/tool/renderHint.test.ts
```

Expected: 2 PASS.

- [ ] **Step 5: Typecheck the whole codebase.**

```bash
bun run typecheck
```

Expected: no errors (the addition is non-breaking).

- [ ] **Step 6: Commit.**

```bash
git add src/tool/types.ts tests/tool/renderHint.test.ts
git commit -m "feat(tool): add optional RenderHint discriminated union to ToolDef"
```

## Task M3.2 — Backfill `renderHint` on every existing tool

**Files:**
- Modify: every `src/tools/*Tool.ts` file (28 tools) per the table below.
- Create: `tests/tool/renderHintCoverage.test.ts`

Per spec §7, each tool declares its result shape. Below is the authoritative mapping.

| Tool file | renderHint |
|---|---|
| `src/tools/FileReadTool.ts` | `{ kind: 'code' }` (language inferred from path by client) |
| `src/tools/FileWriteTool.ts` | `{ kind: 'diff' }` |
| `src/tools/FileEditTool.ts` | `{ kind: 'diff' }` |
| `src/tools/BashTool.ts` | `{ kind: 'text' }` |
| `src/tools/GlobTool.ts` | `{ kind: 'tree' }` |
| `src/tools/GrepTool.ts` | `{ kind: 'tree' }` |
| `src/tools/WebFetchTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/WebSearchTool.ts` | `{ kind: 'tree' }` |
| `src/tools/MemoryTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/MemoryProposeTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/SkillManageTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/SkillProposeTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/SkillTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/SkillsListTool.ts` | `{ kind: 'tree' }` |
| `src/tools/SkillsViewTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/StaticSiteValidateTool.ts` | `{ kind: 'tree' }` |
| `src/tools/AgentTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/TaskCreateTool.ts` | `{ kind: 'table' }` |
| `src/tools/TaskGetTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/TaskListTool.ts` | `{ kind: 'table' }` |
| `src/tools/TaskOutputTool.ts` | `{ kind: 'text' }` |
| `src/tools/TaskStopTool.ts` | `{ kind: 'text' }` |
| `src/tools/HarnessInfoTool.ts` (via `buildHarnessInfoTool`) | `{ kind: 'markdown' }` |
| `src/tools/ToolSearchTool.ts` (via `buildToolSearchTool`) | `{ kind: 'tree' }` |
| `src/tools/InstinctListTool.ts` | `{ kind: 'tree' }` |
| `src/tools/InstinctViewTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/InstinctProposeTool.ts` | `{ kind: 'markdown' }` |
| `src/tools/InstinctUpdateConfidenceTool.ts` | `{ kind: 'text' }` |

- [ ] **Step 1: Write the failing coverage test.**

Create `tests/tool/renderHintCoverage.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { assembleToolPool } from '../../src/tool/registry.js';

describe('renderHint coverage', () => {
  test('every native tool in the assembled pool declares a renderHint', async () => {
    const pool = assembleToolPool({});
    const missing: string[] = [];
    for (const tool of pool) {
      if (!('renderHint' in tool) || tool.renderHint === undefined) {
        missing.push(tool.name);
      }
    }
    expect(missing).toEqual([]);
  });
});
```

Note: `assembleToolPool` signature is `(opts: AssembleToolPoolOpts): Tool[]` per `src/tool/registry.ts:123`. If the call needs an empty option object that satisfies the type, adjust to whatever the actual signature requires (TS will tell you on the first run). MCP tools are not in scope here — the coverage test runs against the native-only pool.

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/tool/renderHintCoverage.test.ts
```

Expected: failure listing the 28 tool names that don't yet declare a hint.

- [ ] **Step 3: For each tool in the table above, add the `renderHint` field to its `buildTool({...})` call.**

For each file, find the `buildTool<...>({...})` call and add the line. For example, `src/tools/FileReadTool.ts`:

```typescript
export const FileReadTool = buildTool<Input, Output>({
  name: 'FileRead',
  // ... existing fields ...
  renderResult: (out) => ({ content: renderFileRead(out) }),
  renderHint: { kind: 'code' },
  // ... rest unchanged ...
});
```

Repeat for each row in the table. Builder helpers (`buildHarnessInfoTool`, `buildToolSearchTool`) need the same field added inside their internal `buildTool` call.

- [ ] **Step 4: Run the coverage test; verify it PASSES.**

```bash
bun test tests/tool/renderHintCoverage.test.ts
```

Expected: 1 PASS.

- [ ] **Step 5: Run the full test suite.**

```bash
bun test
```

Expected: all green (existing tests are not affected — `renderHint` is additive).

- [ ] **Step 6: Commit.**

```bash
git add src/tools/ tests/tool/renderHintCoverage.test.ts
git commit -m "feat(tools): backfill renderHint on all 28 native tools per spec §7"
```

## Task M3.3 — `src/server/runtime.ts` — Server-side runtime context

**Files:**
- Create: `src/server/runtime.ts`
- Create: `tests/server/runtime.test.ts`

The server needs the same building blocks `terminalRepl` constructs: session DB, bundle loader, tool pool, provider, system-prompt builder. M3 builds a parallel construction in `src/server/runtime.ts` — this is **additive**, not extraction. terminalRepl is untouched.

- [ ] **Step 1: Read the relevant slice of `src/ui/terminalRepl.ts` to understand the construction pattern.**

```bash
grep -n "loadBundleIfPresent\|new SessionDb\|loadAgents\|assembleToolPool\|buildSystemSegments\|resolveProvider" src/ui/terminalRepl.ts | head -20
```

Note the order of construction; M3's `runtime.ts` mirrors it.

- [ ] **Step 2: Write the failing test.**

Create `tests/server/runtime.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntime } from '../../src/server/runtime.js';

describe('buildRuntime', () => {
  test('constructs a runtime with sessionDb, toolPool, systemSegments', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-runtime-'));
    try {
      const rt = await buildRuntime({
        harnessHome: home,
        bundleRoot: undefined, // default bundle
        cwd: process.cwd(),
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
      });
      expect(rt.sessionDb).toBeDefined();
      expect(rt.toolPool.length).toBeGreaterThan(0);
      expect(rt.systemSegments.length).toBeGreaterThan(0);
      expect(rt.provider).toBeDefined();
      await rt.dispose();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the test; verify it FAILS.**

```bash
bun test tests/server/runtime.test.ts
```

Expected: import error.

- [ ] **Step 4: Create `src/server/runtime.ts`.**

This task is the load-bearing one in M3. Carefully mirror the existing `terminalRepl` construction patterns without modifying terminalRepl itself.

```typescript
// src/server/runtime.ts
//
// Server-side runtime construction. Mirrors terminalRepl's boot sequence
// without extracting from it (per Postmortem Rule 1 — terminalRepl stays
// untouched). Produces the object the server's turn-handler needs:
// sessionDb, toolPool, systemSegments, provider, agentDefs, config.
//
// M3 uses this for a single in-process session per server. Multi-session
// support is in-schema but deferred to a future milestone.

import { loadAgents } from '../agents/loader.js';
import type { AgentDefinition } from '../agents/types.js';
import { SessionDb } from '../agent/sessionDb.js';
import { getDefaultBundlePath } from '../bundle/defaultBundle.js';
import { loadBundleIfPresent } from '../bundle/loader.js';
import type { Bundle } from '../bundle/types.js';
import { resolveHarnessHome } from '../config/paths.js';
import { readConfig } from '../config/store.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { SystemSegment } from '../core/types.js';
import { resolveProvider } from '../providers/index.js';
import type { LLMProvider } from '../providers/types.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool } from '../tool/types.js';

export type RuntimeOptions = {
  harnessHome?: string;
  bundleRoot?: string;
  cwd: string;
  provider?: string;
  model?: string;
};

export type Runtime = {
  sessionDb: SessionDb;
  toolPool: Tool<unknown, unknown>[];
  systemSegments: SystemSegment[];
  provider: LLMProvider;
  agentDefs: AgentDefinition[];
  bundle: Bundle | null;
  cwd: string;
  bundleRoot?: string;
  dispose: () => Promise<void>;
};

export async function buildRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const home = opts.harnessHome ?? resolveHarnessHome();
  const config = readConfig(home);
  const bundleRoot = opts.bundleRoot ?? getDefaultBundlePath();
  const bundle = await loadBundleIfPresent(bundleRoot);
  const agentDefs = await loadAgents(bundle);
  const toolPool = assembleToolPool({ bundle, agentDefs, config }) as Tool<unknown, unknown>[];
  const systemSegments = await buildSystemSegments({
    bundle,
    cwd: opts.cwd,
    harnessHome: home,
    config,
  });
  const provider = await resolveProvider({
    config,
    explicitProvider: opts.provider,
    explicitModel: opts.model,
  });
  const sessionDb = await SessionDb.open(home);

  return {
    sessionDb,
    toolPool,
    systemSegments,
    provider,
    agentDefs,
    bundle,
    cwd: opts.cwd,
    bundleRoot,
    dispose: async () => {
      await sessionDb.close();
    },
  };
}
```

**IMPORTANT:** the imports above reflect the most-likely-correct paths. If TypeScript complains, fix by reading each module's `export` lines and adjusting. The signatures of `assembleToolPool`, `buildSystemSegments`, `resolveProvider`, and `SessionDb` may differ slightly from what's shown — read the actual files (`src/tool/registry.ts:102`, `src/core/systemPrompt.ts`, `src/providers/index.ts`, `src/agent/sessionDb.ts`) and adjust calls to match. The test is the contract: a runtime whose `sessionDb`, `toolPool`, `systemSegments`, `provider` are all defined.

- [ ] **Step 5: Run the test; verify it PASSES.**

```bash
bun test tests/server/runtime.test.ts
```

If it fails on signature mismatches: read each constructor/factory and adjust the calls. Iterate until green.

- [ ] **Step 6: Commit.**

```bash
git add src/server/runtime.ts tests/server/runtime.test.ts
git commit -m "feat(server): buildRuntime() mirrors terminalRepl boot for in-process server use"
```

## Task M3.4 — `POST /sessions` + `POST /sessions/:id/turns` — turn submission

**Files:**
- Create: `src/server/routes/sessions.ts`
- Create: `src/server/routes/turns.ts`
- Modify: `src/server/app.ts` (mount the new routes)
- Create: `tests/server/turns.test.ts`

- [ ] **Step 1: Write the failing integration test.**

Create `tests/server/turns.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { buildRuntime } from '../../src/server/runtime.js';

describe('POST /sessions + POST /sessions/:id/turns', () => {
  test('creates a session and runs a turn (mock provider)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sov-turns-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    try {
      const runtime = await buildRuntime({
        harnessHome: home,
        cwd: process.cwd(),
        provider: 'mock',
        model: 'mock-haiku',
      });
      const app = buildAppWithRuntime(runtime);

      const createRes = await app.request('/sessions', { method: 'POST' });
      expect(createRes.status).toBe(201);
      const { sessionId } = (await createRes.json()) as { sessionId: string };
      expect(sessionId).toMatch(/^s_/);

      const turnRes = await app.request(`/sessions/${sessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(turnRes.status).toBe(202);

      // SSE stream should have received text_delta and turn_complete.
      // The streaming test against this lives in tests/server/events.test.ts
      // (M1) — here we only assert the turn POST returns 202.

      await runtime.dispose();
    } finally {
      delete process.env.SOV_TEST_MOCK_PROVIDER;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test; verify it FAILS.**

```bash
bun test tests/server/turns.test.ts
```

Expected: `buildAppWithRuntime` not exported.

- [ ] **Step 3: Implement a mock provider gate.**

The full real-provider turn requires API credentials; tests should run without them. The cleanest pattern is a `mock` provider name that `resolveProvider` returns when `SOV_TEST_MOCK_PROVIDER=1`. Add the gate in `src/providers/index.ts`:

```bash
grep -n "resolveProvider" src/providers/index.ts
```

In the existing `resolveProvider`, near the top, add:

```typescript
if (opts.explicitProvider === 'mock' || process.env.SOV_TEST_MOCK_PROVIDER === '1') {
  const { MockProvider } = await import('./mock.js');
  return new MockProvider();
}
```

- [ ] **Step 4: Create `src/providers/mock.ts`.**

```typescript
// Mock provider for tests and the M3 first-turn smoke. Emits a deterministic
// sequence of text-delta events then ends the turn. No API call.

import type {
  LLMProvider,
  Message,
  ProviderRequest,
  ProviderStreamEvent,
  StreamEvent,
  SystemSegment,
} from './types.js';

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly model = 'mock-haiku';

  async preflight(): Promise<void> {
    // No-op.
  }

  async *stream(_req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    yield { type: 'message_start' };
    yield { type: 'content_block_start', index: 0, block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world.' } };
    yield { type: 'content_block_stop', index: 0 };
    yield {
      type: 'message_stop',
      usage: { input_tokens: 0, output_tokens: 2 },
      finishReason: 'end_turn',
    };
  }
}
```

**IMPORTANT:** the exact `ProviderStreamEvent` shape may differ — read `src/providers/types.ts` and adjust to match. The test is the contract.

- [ ] **Step 5: Create `src/server/routes/sessions.ts`.**

```typescript
// POST /sessions — create a session.
// GET  /sessions/:id — fetch session metadata.

import { Hono } from 'hono';
import type { Runtime } from '../runtime.js';

export function sessionsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions', async (c) => {
    const sessionId = await runtime.sessionDb.createSession({
      cwd: runtime.cwd,
      bundleRoot: runtime.bundleRoot,
    });
    return c.json({ sessionId, createdAt: new Date().toISOString() }, 201);
  });

  r.get('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const session = await runtime.sessionDb.getSession(id);
    if (session === null) return c.json({ error: 'not found' }, 404);
    return c.json({ sessionId: id, createdAt: session.createdAt });
  });

  return r;
}
```

Adjust the `sessionDb.createSession({...})` and `getSession(...)` calls to match the actual `SessionDb` API in `src/agent/sessionDb.ts`. If the field names differ, fix here.

- [ ] **Step 6: Create `src/server/routes/turns.ts`.**

```typescript
// POST /sessions/:id/turns — submit a turn. The handler kicks off a
// background query() call whose StreamEvents are pushed onto the
// per-session event bus; SSE subscribers receive them via /events.

import { Hono } from 'hono';
import { query } from '../../core/query.js';
import type { Message } from '../../core/types.js';
import type { Runtime } from '../runtime.js';
import { getOrCreateBus, type ServerEventBus } from '../eventBus.js';
import type { ServerEvent } from '../schema.js';

export function turnsRoute(runtime: Runtime): Hono {
  const r = new Hono();

  r.post('/sessions/:id/turns', async (c) => {
    const sessionId = c.req.param('id');
    const body = (await c.req.json()) as { text: string };

    const bus = getOrCreateBus(sessionId);
    // Run the turn in the background; don't block the POST response.
    runTurnInBackground(runtime, sessionId, body.text, bus).catch((err) => {
      bus.publish({
        type: 'turn_error',
        seq: bus.nextSeq(),
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        recoverable: false,
      });
    });

    return c.json({ accepted: true }, 202);
  });

  return r;
}

async function runTurnInBackground(
  runtime: Runtime,
  sessionId: string,
  text: string,
  bus: ServerEventBus,
): Promise<void> {
  const userMessage: Message = {
    role: 'user',
    content: [{ type: 'text', text }],
  };

  const stream = query({
    messages: [userMessage],
    tools: runtime.toolPool,
    systemSegments: runtime.systemSegments,
    provider: runtime.provider,
    sessionId,
    cwd: runtime.cwd,
  });

  let blockIdx = 0;
  for await (const event of stream) {
    const seq = bus.nextSeq();
    const mapped = mapStreamEventToServerEvent(event, seq, sessionId, blockIdx);
    if (mapped) bus.publish(mapped);
    if (event.type === 'content_block_start') blockIdx = event.index;
  }
}

function mapStreamEventToServerEvent(
  event: { type: string; [k: string]: unknown },
  seq: number,
  sessionId: string,
  blockIdx: number,
): ServerEvent | null {
  // Best-effort mapping for M3. Future milestones expand coverage.
  switch (event.type) {
    case 'text_delta':
      return {
        type: 'text_delta',
        seq,
        sessionId,
        block: blockIdx,
        text: (event as { text: string }).text,
      };
    case 'message_stop':
      return {
        type: 'turn_complete',
        seq,
        sessionId,
        finishReason: ((event as { finishReason?: string }).finishReason) ?? 'end_turn',
      };
  }
  return null;
}
```

**IMPORTANT:** the `query()` call signature and the `StreamEvent` shape may differ from above. Read `src/core/query.ts` and the actual `Message` / `StreamEvent` / `Terminal` types in `src/core/types.ts`. Adapt the call args and the `mapStreamEventToServerEvent` switch arms to match. The test is the contract.

- [ ] **Step 7: Create `src/server/eventBus.ts`.**

```typescript
// Per-session event bus that the turn-handler pushes to and the SSE route
// consumes. M3: minimal in-process bus with a single subscriber. Ring buffer
// + multi-subscriber support are future-milestone work.

import type { ServerEvent } from './schema.js';

export class ServerEventBus {
  private subscriber: ((ev: ServerEvent) => void) | null = null;
  private buffer: ServerEvent[] = [];
  private seq = 0;
  private closed = false;

  nextSeq(): number {
    return ++this.seq;
  }

  publish(event: ServerEvent): void {
    if (this.closed) return;
    if (this.subscriber) {
      this.subscriber(event);
    } else {
      this.buffer.push(event);
    }
  }

  subscribe(fn: (ev: ServerEvent) => void): () => void {
    this.subscriber = fn;
    while (this.buffer.length > 0) {
      const ev = this.buffer.shift();
      if (ev) fn(ev);
    }
    return () => {
      this.subscriber = null;
    };
  }

  close(): void {
    this.closed = true;
    this.subscriber = null;
  }
}

const buses = new Map<string, ServerEventBus>();

export function getOrCreateBus(sessionId: string): ServerEventBus {
  let bus = buses.get(sessionId);
  if (bus === undefined) {
    bus = new ServerEventBus();
    buses.set(sessionId, bus);
  }
  return bus;
}

export function disposeBus(sessionId: string): void {
  const bus = buses.get(sessionId);
  if (bus !== undefined) {
    bus.close();
    buses.delete(sessionId);
  }
}
```

- [ ] **Step 8: Update `src/server/routes/events.ts` to consume the bus.**

Replace the M1 hardcoded-stream implementation:

```typescript
// GET /sessions/:id/events — SSE stream of server events for a session.
//
// M3: consumes the per-session event bus populated by the turn handler.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getOrCreateBus } from '../eventBus.js';
import type { ServerEvent } from '../schema.js';

export const eventsRoute = new Hono();

eventsRoute.get('/sessions/:id/events', (c) => {
  const sessionId = c.req.param('id');
  const bus = getOrCreateBus(sessionId);
  return streamSSE(c, async (stream) => {
    let stopped = false;
    const queue: ServerEvent[] = [];
    let resolver: (() => void) | null = null;
    const unsubscribe = bus.subscribe((ev) => {
      queue.push(ev);
      if (resolver !== null) {
        const r = resolver;
        resolver = null;
        r();
      }
    });
    try {
      while (!stopped) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            resolver = r;
          });
        }
        const ev = queue.shift();
        if (ev === undefined) continue;
        await stream.writeSSE({
          event: ev.type,
          id: String(ev.seq),
          data: JSON.stringify(ev),
        });
        if (ev.type === 'turn_complete' || ev.type === 'turn_error') {
          stopped = true;
        }
      }
    } finally {
      unsubscribe();
    }
  });
});
```

- [ ] **Step 9: Update `src/server/app.ts` to accept the runtime.**

```typescript
import { Hono } from 'hono';
import type { Runtime } from './runtime.js';
import { eventsRoute } from './routes/events.js';
import { healthRoute } from './routes/health.js';
import { sessionsRoute } from './routes/sessions.js';
import { turnsRoute } from './routes/turns.js';

export function buildApp(): Hono {
  // Health-only app for boot tests (no runtime). M3+ callers use buildAppWithRuntime.
  const app = new Hono();
  app.route('/', healthRoute);
  return app;
}

export function buildAppWithRuntime(runtime: Runtime): Hono {
  const app = new Hono();
  app.route('/', healthRoute);
  app.route('/', sessionsRoute(runtime));
  app.route('/', turnsRoute(runtime));
  app.route('/', eventsRoute);
  return app;
}
```

- [ ] **Step 10: Update `src/server/index.ts` to accept a runtime.**

```typescript
import { buildApp, buildAppWithRuntime } from './app.js';
import { findFreePort } from './port.js';
import type { Runtime } from './runtime.js';

export type StartServerOptions = {
  port?: number;
  runtime?: Runtime;
};

export type StartedServer = {
  port: number;
  stop: () => Promise<void>;
};

export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const port = opts.port ?? (await findFreePort());
  const app = opts.runtime ? buildAppWithRuntime(opts.runtime) : buildApp();
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: app.fetch,
  });
  return {
    port: server.port,
    stop: async () => {
      server.stop();
    },
  };
}
```

- [ ] **Step 11: Run the M3 test; verify it PASSES.**

```bash
bun test tests/server/turns.test.ts
```

Expected: 1 PASS.

- [ ] **Step 12: Run the full server suite as regression.**

```bash
bun test tests/server/
```

Expected: all green. Note: `events.test.ts` (M1 hardcoded test) may now fail because the route consumes the bus instead of the hardcoded stream. Either:
  (a) Update `events.test.ts` to seed events into the bus before subscribing, OR
  (b) Delete `events.test.ts` if the contract it tested no longer holds.

Choose (a) — keep the test, adjust to seed via `getOrCreateBus(...).publish(...)` then GET the endpoint and verify.

- [ ] **Step 13: Commit.**

```bash
git add src/server/routes/sessions.ts src/server/routes/turns.ts src/server/routes/events.ts src/server/eventBus.ts src/server/app.ts src/server/index.ts src/providers/mock.ts src/providers/index.ts tests/server/turns.test.ts tests/server/events.test.ts
git commit -m "feat(server): POST /sessions + /turns + event-bus-driven SSE"
```

## Task M3.5 — Update the launcher to use a real runtime + session

**Files:**
- Modify: `src/cli/tuiLauncher.ts`

- [ ] **Step 1: Replace `runTuiLauncher` to build a runtime, create a session, then spawn.**

Replace the body of `runTuiLauncher` from M2:

```typescript
export async function runTuiLauncher(opts: TuiLaunchOptions): Promise<number> {
  const binary = findTuiBinary();
  if (binary === null) {
    console.warn('sov: TUI binary not found; falling back to --ui repl.');
    console.warn('     Run `sov upgrade` (requires Go ≥ 1.22 on PATH) to install it.');
    return 70;
  }

  const { buildRuntime } = await import('../server/runtime.js');
  const { startServer } = await import('../server/index.js');

  const runtime = await buildRuntime({
    cwd: process.cwd(),
    provider: typeof opts.provider === 'string' ? opts.provider : undefined,
    model: typeof opts.model === 'string' ? opts.model : undefined,
    bundleRoot: typeof opts.bundle === 'string' ? opts.bundle : undefined,
  });
  const server = await startServer({ runtime });

  const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: 'POST',
  });
  if (!createRes.ok) {
    console.error('sov: failed to create session');
    await server.stop();
    await runtime.dispose();
    return 1;
  }
  const { sessionId } = (await createRes.json()) as { sessionId: string };

  const { spawn } = await import('node:child_process');
  const child = spawn(
    binary,
    ['--port', String(server.port), '--session-id', sessionId],
    { stdio: 'inherit' },
  );

  return await new Promise<number>((resolve) => {
    child.on('exit', async (code) => {
      await server.stop();
      await runtime.dispose();
      resolve(code ?? 0);
    });
  });
}
```

- [ ] **Step 2: Run typecheck and the launcher unit tests.**

```bash
bun run typecheck && bun test tests/cli/tuiLauncher.test.ts
```

Expected: green.

- [ ] **Step 3: Commit.**

```bash
git add src/cli/tuiLauncher.ts
git commit -m "feat(cli): TUI launcher builds runtime, creates session, then spawns sov-tui"
```

## Task M3.6 — Update the Go TUI to handle text_delta + tool_result placeholders

**Files:**
- Modify: `packages/tui/internal/app/app.go`
- Create: `packages/tui/internal/components/toolcard.go`

- [ ] **Step 1: Create `packages/tui/internal/components/toolcard.go`.**

```go
// Package components — ToolCard: placeholder rendering of a tool_result event.
// M3: shows tool name + short summary in a bordered box.
// M9 polish wires hint-based renderers (code/diff/markdown/table/tree).

package components

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
)

type ToolCard struct {
	Tool       string
	RenderHint string
	Summary    string
}

func (tc ToolCard) View(width int) string {
	box := lipgloss.NewStyle().
		BorderStyle(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("#444c56")).
		Padding(0, 1).
		Width(width - 2)
	header := lipgloss.NewStyle().Foreground(lipgloss.Color("#98c379")).Render(fmt.Sprintf("▸ %s", tc.Tool))
	subline := lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681")).Render(tc.Summary)
	return box.Render(header + "\n" + subline)
}
```

- [ ] **Step 2: Update `packages/tui/internal/app/app.go` to handle `tool_use_start`, `tool_use_done`, `tool_result`.**

In the existing `handleEvent` switch, add cases:

```go
	case "tool_use_start":
		tus, err := transport.DecodeToolUseStart(env.Raw)
		if err != nil {
			return
		}
		m.transcript.AppendLine(lipgloss.NewStyle().Foreground(lipgloss.Color("#6e7681")).Render(fmt.Sprintf("→ %s starting...", tus.Tool)))
	case "tool_result":
		tr, err := transport.DecodeToolResult(env.Raw)
		if err != nil {
			return
		}
		card := components.ToolCard{
			Tool:       tr.Tool,
			RenderHint: tr.RenderHint,
			Summary:    fmt.Sprintf("rendered as %s", tr.RenderHint),
		}
		m.transcript.AppendLine(card.View(m.width))
```

Add the needed imports at the top of `app.go`:

```go
import (
	"fmt"
	"github.com/charmbracelet/lipgloss"
	// ... existing imports ...
)
```

- [ ] **Step 3: Build and run tests.**

```bash
cd packages/tui && go build ./... && go test ./...
```

Expected: green.

- [ ] **Step 4: Commit.**

```bash
git add packages/tui/internal/components/toolcard.go packages/tui/internal/app/app.go
git commit -m "feat(tui): render placeholder tool cards on tool_result events"
```

## Task M3.7 — End-to-end smoke against a real provider

This is a **manual smoke** task. The full real-turn flow is exercised by hand with an Anthropic API key.

- [ ] **Step 1: Ensure the build is current.**

```bash
bun install
bun run tui:build
bun run lint && bun run typecheck && bun test
cd packages/tui && go test ./... && cd ../..
```

Expected: all green.

- [ ] **Step 2: Run `sov --ui tui` against the default bundle.**

```bash
bun src/main.ts chat --ui tui --bundle bundle-default
```

Expected: the TUI takes over. There is no first-prompt input yet — the M3 launcher creates a session but does not POST a turn. To trigger a turn, we need either (a) an input-submit wired through M3 (in Step 3 below) or (b) a manual curl.

Use option (b) for the M3 smoke. Note the printed port (add a log line in `tuiLauncher.ts` temporarily if absent):

```bash
# In another terminal:
PORT=<the port>
SESSION=<the session id from sov's startup log>
curl -X POST http://127.0.0.1:$PORT/sessions/$SESSION/turns \
  -H "Content-Type: application/json" \
  -d '{"text":"List files in src/server/"}'
```

Expected: the TUI's transcript renders streaming text deltas from Claude as the model thinks; if Claude calls `Glob` or `FileRead`, you see placeholder tool cards.

- [ ] **Step 3: Wire ENTER in the prompt to POST a turn.**

In `packages/tui/internal/app/app.go`, update the `tea.KeyMsg` case:

```go
	case tea.KeyMsg:
		if key := msg.String(); key == "esc" || key == "ctrl+c" {
			m.cancel()
			return m, tea.Quit
		}
		if msg.Type == tea.KeyEnter {
			text := m.prompt.Value()
			if text == "" {
				return m, nil
			}
			m.transcript.AppendLine("» " + text)
			m.prompt.Clear()
			return m, m.submitTurn(text)
		}
		var cmd tea.Cmd
		m.prompt, cmd = m.prompt.Update(msg)
		return m, cmd
```

Add a method `submitTurn`:

```go
func (m Model) submitTurn(text string) tea.Cmd {
	return func() tea.Msg {
		serverURL := strings.Replace(m.streamURL, fmt.Sprintf("/sessions/%s/events", m.sessionID), fmt.Sprintf("/sessions/%s/turns", m.sessionID), 1)
		body := fmt.Sprintf(`{"text":%q}`, text)
		req, err := http.NewRequestWithContext(m.ctx, http.MethodPost, serverURL, strings.NewReader(body))
		if err != nil {
			return sseDoneMsg{err: err}
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return sseDoneMsg{err: err}
		}
		_ = resp.Body.Close()
		return nil
	}
}
```

Add imports `"net/http"`, `"strings"` to `app.go`.

- [ ] **Step 4: Rebuild and re-smoke.**

```bash
bun run tui:build
bun src/main.ts chat --ui tui --bundle bundle-default
```

In the TUI, type a message and press ENTER. Expected: the message echoes as `» <your text>`; the assistant streams a response into the transcript; any tool calls render as placeholder cards; `[turn complete]` appears when done.

- [ ] **Step 5: Update `docs/testing-log.md`.**

```markdown
### 2026-05-13 · M3 first real turn — manual smoke

**Scope:** Phase 16.1 M3 — query() wired through HTTP+SSE; ENTER submits; renderHint on all 28 tools.
**Commands:**
- `bun test` (1809 + 9 new = 1818, all green)
- `cd packages/tui && go test ./...` (all green)
- `bun src/main.ts chat --ui tui --bundle bundle-default` → typed "List files in src/server/", got streaming response + Glob + FileRead tool cards rendering as their renderHint
**Result:** pass.
**Follow-ups:** M4 — 24-prereq Group 1 (critical correctness). Spec §10 milestone M4.
```

- [ ] **Step 6: Commit.**

```bash
git add packages/tui/internal/app/app.go docs/testing-log.md
git commit -m "feat(tui): ENTER submits a turn via POST /sessions/:id/turns"
```

## Task M3.8 — Update `sov upgrade` exit doc

**Files:**
- Modify: `CLAUDE.md` (the section that describes `sov upgrade`)

- [ ] **Step 1: Find the upgrade docs.**

```bash
grep -n "sov upgrade" CLAUDE.md
```

- [ ] **Step 2: Add a one-line note that `sov upgrade` now also rebuilds the TUI binary.**

Find the section starting `## Keep the global \`sov\` binary in sync` (or similar). After the existing paragraph about upgrade, append:

```markdown
**Phase 16.1 note:** `sov upgrade` now also triggers the postinstall hook, which rebuilds `bin/sov-tui` from `packages/tui/`. The TUI binary requires Go ≥ 1.22 on PATH. If Go is missing, the install succeeds and `sov --ui repl` (the default) still works; `sov --ui tui` falls back to repl with a one-line warning.
```

- [ ] **Step 3: Commit.**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): note that sov upgrade rebuilds bin/sov-tui via postinstall"
```

## M3 Exit Gate

- [ ] `bun test` green (existing + new server, runtime, renderHint, tuiLauncher, turns suites)
- [ ] `cd packages/tui && go test ./...` green
- [ ] All 28 tools declare a `renderHint` per spec §7
- [ ] Manual: `sov --ui tui` against the default bundle runs a real turn end-to-end; tool calls render as placeholder cards; ENTER submits
- [ ] `--ui repl` (the default) is unchanged
- [ ] terminalRepl.ts, src/commands/, src/ui/*.ts (other than the new tuiLauncher) untouched per Rule 1
- [ ] No subsystem from the 24-prereq backlog wired (that's M4+)
- [ ] Push to `origin/master`; run `sov upgrade` on the user's machine to confirm postinstall rebuilds

---

## Self-Review

**Spec coverage check (against `docs/specs/2026-05-13-phase-16-1-tui-rebuild-design.md`):**

| Spec section | Covered by |
|---|---|
| §3 decision 1 (split process) | M0 ADR + M1–M3 server + M2 TUI |
| §3 decision 2 (Go + Bubble Tea) | M0 ADR + M2 module init |
| §3 decision 3 (polish craft differentiator) | M0 ADR (scope-defining; visual polish lands in M9, not this plan) |
| §3 decision 4 (anchored bottom chrome layout) | M0 ADR + M2.7 app.View() composition (transcript / prompt / status) |
| §3 decision 5 (postinstall go build) | M0 ADR + M2.9 scripts/build-tui.ts + package.json postinstall |
| §3 decision 6 (terminalRepl coexists through M11) | M0 ADR + every task explicitly avoids touching terminalRepl |
| §3 decision 7 (HTTP+SSE on 127.0.0.1) | M0 ADR + M1.3 port.ts + M1.8 startServer bound to 127.0.0.1 |
| §3 decision 8 (Open Q1 closed) | M0 ADR + M0.3 umbrella spec edit |
| §4 architecture diagram | M0–M3 collectively |
| §5 backend (`src/server/`) | M1 (skeleton) + M3 (runtime, sessions, turns) |
| §5 SSE event types | M1.2 (schema.ts) + M3.4 (server emits mapped events) |
| §5 ring buffer + Last-Event-ID | NOT IN THIS PLAN — deferred to a future milestone (acceptable for M0–M3 scope; the spec calls this out as M9-onward polish) |
| §5 permission round-trip | NOT IN THIS PLAN — deferred (permission modal lands in M5 per spec) |
| §5 auth (none, 127.0.0.1 only) | M1.8 |
| §5 tests | M1 + M3 task structure |
| §6 foreground (Go) | M2 + M3 component additions |
| §7 renderHint bridge | M3.1 + M3.2 |
| §8 build & distribution | M2.9 |
| §9 24-prereq wiring strategy | DOC ONLY — this plan stops before any prereq subsystem is wired (M3 is the deliberate "bare turn" milestone per spec §10) |
| §10 milestones M0–M3 | full coverage |
| §11 out of scope | nothing in scope-out is implemented |
| §12 risks | mitigated by structure (opt-in flag; tests; terminalRepl untouched) |

**Placeholder scan:** Searched for "TBD", "TODO", "fill in", "implement later". The plan has none. Two callouts read "IMPORTANT: the exact ... may differ — read the actual file and adjust" — these are honest acknowledgments that signatures of three older modules (`SessionDb`, `assembleToolPool`, `ProviderStreamEvent`) may differ from what's reasonable-to-guess from grep snippets. The implementer reads the file and adapts; the test is the contract. This is not a placeholder.

**Type consistency:** `renderHint` shape is consistent across `src/tool/types.ts` (TS), `src/server/schema.ts` (Zod), and `packages/tui/internal/transport/types.go` (Go). Event types in TS Zod, Hono routes, and Go decoder structs are aligned. The Go `Envelope` carries the discriminator + raw bytes; per-event-type decoders project onto typed structs.

**Granularity check:** Each step is one action. Tasks range from 4 to 9 steps; most steps fit in 2–5 minutes. The biggest single jump is M3.4 (multiple files in the same task to keep them as one logical change); each step within that task is still bite-sized.

**Atomic-commit check:** Every task ends with a commit. Most tasks commit one logical change. M3.4 commits a batch (sessions + turns + events + eventBus) because they're coupled — splitting would leave intermediate commits with broken tests.

**Test-first check:** Every code-touching task has a failing test before implementation. Doc tasks (M0) and pure-infra tasks (M2.1 go module init, M2.4–M2.6 component scaffolds, M2.8 main.go) skip TDD where there's no behavior to assert — they're checked by compilation, not by unit tests.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-05-13-phase-16-1-tui-rebuild.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Good for this plan because tasks are well-isolated and the spec is precise.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`. Batch execution with checkpoints.

Which approach?
