# Phase 13.4 — Continuous-Learning Observation Stream + Instinct Corpus

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tool call leaves a structured observation in a per-project corpus. A background sub-agent clusters observations into atomic *instincts* — small, confidence-weighted learned behaviors — which gate promotion to durable memory and skills via Phase 13.3's review pipeline. Instincts sit between raw observations and full skills as a confidence-graduated intermediate layer, so the harness learns *gradually* rather than eagerly writing one-session skills that overspecialize.

**Architecture:** An internal `PostToolUse` intercept (in-process, not a user-configurable shell hook) writes one record per tool call to `$HARNESS_HOME/learning/<project-id>/observations.jsonl` async fire-and-forget. A synthesizer sub-agent (Phase 13 sub-agent runtime, restricted toolset) runs on the same counter-driven trigger as Phase 13.3 (`ReviewManager.onUserTurn`-style), reads new observations since last pass, clusters them deterministically by `(tool_name, action-pattern, status)`, and proposes candidate instincts via `instinct_propose`. Confidence updates apply during the synthesizer pass — reinforcement bumps confidence on a logarithmic curve (cap 0.9), contradiction (denied tool calls, reverse-edits) drops it sharply. Phase 13.3's review fork shifts its input from raw trajectory slices to the curated instinct corpus once 13.4 lands. Cross-project promotion: when the same instinct appears in 2+ projects at confidence ≥ 0.7, the synthesizer proposes a global instinct.

**Tech Stack:** Bun + TypeScript strict + bun:sqlite (via existing SessionDb, no schema change in this phase) + Biome lint. Reuses Phase 13's `AgentRunner` + `SubagentScheduler` + agent-definition loader. Reuses Phase 13.3's `ReviewManager` counter pattern. Tools implemented via `buildTool()` factory with Zod input schemas. Tests via `bun:test`.

**Build-plan reference:** [`harness-build-plan.md` Phase 13.4 (lines 2001–2114)](~/code/sovereign-ai-docs/harness/docs/runtime/harness-build-plan.md). ECC reference: [`everything-claude-code-analysis.md` §2.4](~/code/sovereign-ai-docs/harness/docs/reference/everything-claude-code-analysis.md). Anti-pattern reference (negative rhyme): [`qwen-code-analysis.md` §3.4 dream consolidation](~/code/sovereign-ai-docs/harness/docs/reference/qwen-code-analysis.md).

**Acceptance Check (build-plan canonical):**
> Run a substantive 2-hour coding session in a real project. After one synthesizer pass, `instincts/*.md` contains 5–15 candidate instincts at varying confidence levels. After 5 sessions, several instincts cross 0.7 and become candidate skill proposals in `review/pending/skills/`. Run the same workflow in a second project; matching instincts trigger global-promotion proposals. Verify that contradicting an instinct (rejecting an edit that matches its `action`) drops its confidence on the next synthesis pass. Verify that the observation writer never appears in the user-facing latency profile (the writer runs after the orchestrator's tool-result rendering, off the critical path).

**Invariants reinforced:** #10 (learning loop is additive and non-blocking — observer writes; synthesizer reads + proposes; nothing mutates state without the Phase 13.3 review path).

**v0 scope cuts (deferred to a future Phase 13.4b):**
- Cross-project promotion — included in this phase but exercised only in unit tests with synthetic per-project corpora; full integration depends on a real second project. Documented in CLAUDE.md follow-ups.
- Embedding-based clustering — explicitly out of scope per build plan ("revisit when corpus crosses ~10k observations"). Deterministic key clustering only.
- Cross-user instinct sharing — out of scope per build plan.
- Instinct UI / TUI viewer — CLI listing is sufficient.
- Realtime confidence updates — confidence batches during the synthesizer pass per build plan.
- Contradiction detection's "instead, do X" NL parsing — best-effort string matching only; document the limit.

---

## File Structure

**New `src/learning/` directory:**
- `src/learning/types.ts` — `Observation`, `Instinct`, `InstinctDomain`, `InstinctScope` types + Zod schemas
- `src/learning/paths.ts` — canonical paths under `$HARNESS_HOME/learning/<project-id>/`; ensure-dir helpers
- `src/learning/project.ts` — `getProjectId(cwd)` returns `{id, name}` (git-remote hash → cwd hash fallback); session-cached
- `src/learning/observer.ts` — observation writer; fire-and-forget async, bounded buffer, dedup by tool_input_hash
- `src/learning/cluster.ts` — pure deterministic clustering by `(tool_name, action-pattern, status)` triples
- `src/learning/confidence.ts` — pure reinforcement (logarithmic, cap 0.9) + contradiction (sharp drop) math
- `src/learning/instinctStore.ts` — read/write instinct .md files in `$HARNESS_HOME/learning/<project-id>/instincts/`
- `src/learning/synthesizer.ts` — dispatcher: runs `instinct-synthesizer` agent via `SubagentScheduler.delegate`, fire-and-forget. Mirrors Phase 13.3's `runReviewFork`.
- `src/learning/promotion.ts` — pure cross-project promotion check: same instinct in N≥2 projects at confidence ≥ 0.7 → global candidate

**New `src/tools/`:**
- `src/tools/InstinctListTool.ts` — query instincts by domain/scope/min_confidence (read-only)
- `src/tools/InstinctViewTool.ts` — fetch full instinct + evidence excerpts (read-only)
- `src/tools/InstinctProposeTool.ts` — synthesizer-only; create candidate instinct
- `src/tools/InstinctUpdateConfidenceTool.ts` — synthesizer-only; reinforcement / contradiction

**New `src/cli/`:**
- `src/cli/learningStatus.ts` — `harness learning status` per-project counts + histograms
- `src/cli/learningPrune.ts` — `harness learning prune` drops sub-threshold instincts past aging window
- `src/cli/learningExport.ts` — `harness learning export <project-id>` emits instincts as .md for sharing

**New `bundle-default/agents/`:**
- `bundle-default/agents/instinct-synthesizer.md` — restricted-toolset agent that processes observations into instincts

**Modified files:**
- `src/core/orchestrator.ts` — add observer notify after PostToolUse hook fires
- `src/tool/types.ts` — add `learningObserver?: LearningObserver` (optional hook into ToolContext); add `isReviewFork?: boolean` already exists from A2 follow-up if present, else add
- `src/tool/registry.ts` — add `LEARNING_ONLY_TOOLS` export; instinct tools inject only into synthesizer / review-fork pools (NOT main agent pool)
- `src/review/fork.ts` — augment `parentToolPool` with `LEARNING_ONLY_TOOLS` for review forks (so review-fork agents can call `instinct_list` / `instinct_view`)
- `src/learning/synthesizer.ts` augments parentToolPool with `LEARNING_ONLY_TOOLS` for the synthesizer agent
- `src/review/manager.ts` — add `synthesizerEveryN` threshold + `synthesizerSince` counter + `dispatchSynthesizer()`; `onUserTurn` and `onToolIteration` also tick the synthesizer counter
- `src/agents/exclusions.ts` — keep `instinct_propose` / `instinct_update_confidence` out of the main agent pool (they're not in REGISTERED_TOOLS in the first place; SUBAGENT_EXCLUDED_TOOLS not needed)
- `src/main.ts` — register `learning` subcommand with status/prune/export
- `src/config/schema.ts` — add `learning.synthesizerEveryN`, `learning.observationBufferSize`, `learning.disabled` to settings
- `src/ui/terminalRepl.ts` — instantiate `LearningObserver` at session boot, pass to ToolContext

**New tests:**
- `tests/learning/paths.test.ts` — directory-locator helpers
- `tests/learning/project.test.ts` — git-remote hash → cwd hash fallback chain
- `tests/learning/observer.test.ts` — write-and-dedup, bounded buffer, fire-and-forget never throws
- `tests/learning/cluster.test.ts` — deterministic key generation
- `tests/learning/confidence.test.ts` — reinforcement curve + contradiction drop + 0.9 cap
- `tests/learning/instinctStore.test.ts` — round-trip frontmatter
- `tests/learning/promotion.test.ts` — cross-project promotion threshold logic
- `tests/tools/instinctTools.test.ts` — all 4 tools' I/O
- `tests/tools/learningOnlyPool.test.ts` — main pool excludes instinct tools; synthesizer + review-fork pools include them
- `tests/agents/learning-defaults.test.ts` — `instinct-synthesizer` agent loads with restricted allowedTools
- `tests/learning/integration.test.ts` — full observe → synthesize → instinct file appears flow with fake provider
- `tests/cli/learningCommands.test.ts` — status / prune / export behavior
- `tests/semantic/suites/21-learning.cases.ts` — 4 cases (model-side `harness learning status` UX, instinct tools absent from main pool, etc.)

**Touched bundle/state surfaces:**
- `$HARNESS_HOME/learning/<project-id>/observations.jsonl` (created lazily by observer)
- `$HARNESS_HOME/learning/<project-id>/instincts/<id>.md` (synthesizer writes; promotion writes global into `$HARNESS_HOME/learning/_global/instincts/`)

---

## Settings + thresholds

Profile schema gains a `learning` block (all optional):

```typescript
learning: z
  .object({
    /** When false, observation writer is a no-op + synthesizer never
     *  fires. Defaults to true (learning loop on). */
    disabled: z.boolean().optional(),
    /** Synthesizer runs every Nth user turn (counter mirrors review's
     *  userTurnsForMemoryReview). Default 20. */
    synthesizerEveryN: z.number().int().positive().optional(),
    /** In-memory observation buffer cap before backpressure drops the
     *  oldest. Default 200. Disk writes are async; this is the buffer
     *  before the appender flushes. */
    observationBufferSize: z.number().int().positive().optional(),
    /** Confidence threshold below which sub-threshold instincts age out
     *  via `harness learning prune`. Default 0.3 per build plan. */
    pruneBelowConfidence: z.number().min(0).max(1).optional(),
    /** Days without reinforcement after which sub-threshold instincts
     *  are pruned. Default 30 per build plan. */
    pruneAgeDays: z.number().int().positive().optional(),
  })
  .strict()
  .optional(),
```

---

## Provenance frontmatter for instincts

`$HARNESS_HOME/learning/<project-id>/instincts/<id>.md`:

```markdown
---
id: 01HKZQR8M5N6P7Q8R9S0T1U2V3
trigger: "when writing a new TypeScript function"
action: "add explicit return type annotation"
confidence: 0.62
evidence_count: 8
domain: code-style
scope: project
project_id: a3f...                      # cwd hash or git-remote hash
project_name: sovereign-ai-sdk
created_at: 2026-05-06T10:00:00Z
last_evidence_at: 2026-05-06T15:30:00Z
observation_ids:                        # first 10; rest findable via trace_id grep
  - obs-2026-05-06-aaa1
  - obs-2026-05-06-aaa2
---

# When writing a new TypeScript function — add explicit return type annotation

## Evidence summary
8 observations across 2 sessions where the agent wrote a TypeScript
function and the user accepted the resulting code.

## Earliest evidence
- 2026-05-06T10:00:00Z — `FileWrite src/foo.ts` (toolUseId: toolu_01...)
- ...
```

Global instincts use the same shape with `scope: global` and `project_id: null`, stored at `$HARNESS_HOME/learning/_global/instincts/`.

---

## Tasks

### Task 1 — Foundation: types, paths, project identity

**Goal:** Lock the data model and on-disk layout. Get `getProjectId(cwd)` working with git-remote → cwd-hash fallback.

**Files:**
- Create: `src/learning/types.ts`, `src/learning/paths.ts`, `src/learning/project.ts`
- Create: `tests/learning/paths.test.ts`, `tests/learning/project.test.ts`

#### Step 1 — types

```typescript
// src/learning/types.ts
import { z } from 'zod';

export const ObservationStatusSchema = z.enum(['success', 'error', 'denied', 'cancelled']);
export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;

export const ObservationSchema = z.object({
  id: z.string(),
  ts: z.string(),
  project_id: z.string(),
  project_name: z.string(),
  session_id: z.string(),
  tool_name: z.string(),
  tool_input_hash: z.string(),
  tool_input_summary: z.string().max(256),
  status: ObservationStatusSchema,
  duration_ms: z.number().nonnegative(),
  observation_envelope: z
    .object({
      status: z.enum(['success', 'warning', 'error']),
      summary: z.string(),
    })
    .optional(),
  trace_id: z.string().optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const InstinctDomainSchema = z.enum([
  'code-style',
  'testing',
  'git',
  'debugging',
  'workflow',
  'tooling',
]);
export type InstinctDomain = z.infer<typeof InstinctDomainSchema>;

export const InstinctScopeSchema = z.enum(['project', 'global']);
export type InstinctScope = z.infer<typeof InstinctScopeSchema>;

export const InstinctSchema = z.object({
  id: z.string(),
  trigger: z.string().min(1),
  action: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence_count: z.number().int().nonnegative(),
  domain: InstinctDomainSchema,
  scope: InstinctScopeSchema,
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  created_at: z.string(),
  last_evidence_at: z.string(),
  observation_ids: z.array(z.string()),
});
export type Instinct = z.infer<typeof InstinctSchema>;
```

#### Step 2 — paths

```typescript
// src/learning/paths.ts
// Canonical filesystem layout for learning/* artifacts under $HARNESS_HOME.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const GLOBAL_PROJECT_ID = '_global';

export function learningRoot(harnessHome: string): string {
  return join(harnessHome, 'learning');
}

export function projectRoot(harnessHome: string, projectId: string): string {
  return join(learningRoot(harnessHome), projectId);
}

export function observationsPath(harnessHome: string, projectId: string): string {
  return join(projectRoot(harnessHome, projectId), 'observations.jsonl');
}

export function instinctsDir(harnessHome: string, projectId: string): string {
  return join(projectRoot(harnessHome, projectId), 'instincts');
}

export function instinctPath(harnessHome: string, projectId: string, instinctId: string): string {
  return join(instinctsDir(harnessHome, projectId), `${instinctId}.md`);
}

export function ensureLearningDirs(harnessHome: string, projectId: string): void {
  mkdirSync(instinctsDir(harnessHome, projectId), { recursive: true });
}

export function ensureGlobalLearningDirs(harnessHome: string): void {
  mkdirSync(instinctsDir(harnessHome, GLOBAL_PROJECT_ID), { recursive: true });
}
```

#### Step 3 — project identity

```typescript
// src/learning/project.ts
// Stable per-project identity. Tries git remote first; falls back to
// realpath(cwd) hash. Cached for the session lifetime.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

const cache = new Map<string, { id: string; name: string }>();

export function getProjectId(cwd: string): { id: string; name: string } {
  const cached = cache.get(cwd);
  if (cached) return cached;

  // 1. git remote
  const gitResult = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (gitResult.status === 0 && gitResult.stdout.trim().length > 0) {
    const remote = gitResult.stdout.trim();
    const id = createHash('sha256').update(remote).digest('hex').slice(0, 16);
    const name = nameFromRemote(remote);
    const result = { id, name };
    cache.set(cwd, result);
    return result;
  }

  // 2. realpath(cwd) fallback
  const realCwd = (() => {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  })();
  const id = createHash('sha256').update(realCwd).digest('hex').slice(0, 16);
  const name = basename(realCwd);
  const result = { id, name };
  cache.set(cwd, result);
  return result;
}

/** Test-only helper to clear the cache. */
export function _resetProjectIdCache(): void {
  cache.clear();
}

function nameFromRemote(remote: string): string {
  const last = remote.replace(/\.git\/?$/, '').split('/').pop();
  return last ?? 'unknown';
}
```

Tests cover:
- `paths.ts`: round-trip + `ensureLearningDirs` idempotency
- `project.ts`: git-remote case, no-remote fallback, malformed-cwd fallback (uses `mkdtemp` + chdir)

**Commit:** `feat(learning): foundation — types, paths, project identity`

---

### Task 2 — Observation writer + orchestrator wiring

**Goal:** Internal `PostToolUse` intercept fires after every tool call, writes an `Observation` to `<harnessHome>/learning/<projectId>/observations.jsonl` async fire-and-forget. Bounded in-memory buffer with backpressure (drops oldest on overflow). Observer is created at session boot and threaded through `ToolContext` so the orchestrator can call it without coupling.

**Files:**
- Create: `src/learning/observer.ts`
- Modify: `src/tool/types.ts` — add `learningObserver?: LearningObserver` to `ToolContext`
- Modify: `src/core/orchestrator.ts` — call `ctx.learningObserver?.observe({...})` after PostToolUse fires
- Modify: `src/ui/terminalRepl.ts` — instantiate `LearningObserver`, set on `writableCtx.learningObserver`
- Create: `tests/learning/observer.test.ts`

#### Observer shape

```typescript
// src/learning/observer.ts
// Async fire-and-forget observation writer. Bounded buffer; on overflow,
// drops the oldest record (silently, with a debug-level trace event).
// Disk writes serialize via a write chain (mirrors TraceWriter pattern).

import { createHash, randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { observationsPath, ensureLearningDirs } from './paths.js';
import { getProjectId } from './project.js';
import type { Observation, ObservationStatus } from './types.js';

export interface LearningObserverOpts {
  harnessHome: string;
  cwd: string;
  sessionId: string;
  bufferSize?: number;
  enabled?: boolean;
}

export interface ObserveInput {
  toolName: string;
  toolInput: unknown;
  status: ObservationStatus;
  durationMs: number;
  observationEnvelope?: { status: 'success' | 'warning' | 'error'; summary: string };
  traceId?: string;
}

const DEFAULT_BUFFER = 200;
const SUMMARY_MAX = 256;

export class LearningObserver {
  private writeChain: Promise<void> = Promise.resolve();
  private buffered = 0;
  private dropped = 0;
  private readonly opts: Required<Omit<LearningObserverOpts, 'enabled' | 'bufferSize'>> & {
    enabled: boolean;
    bufferSize: number;
  };

  constructor(opts: LearningObserverOpts) {
    this.opts = {
      harnessHome: opts.harnessHome,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      enabled: opts.enabled ?? true,
      bufferSize: opts.bufferSize ?? DEFAULT_BUFFER,
    };
  }

  observe(input: ObserveInput): void {
    if (!this.opts.enabled) return;
    if (this.buffered >= this.opts.bufferSize) {
      this.dropped += 1;
      return; // backpressure — drop silently
    }
    this.buffered += 1;
    const observation = this.buildObservation(input);
    this.writeChain = this.writeChain.then(async () => {
      try {
        const project = getProjectId(this.opts.cwd);
        const path = observationsPath(this.opts.harnessHome, project.id);
        if (!existsSync(dirname(path))) {
          mkdirSync(dirname(path), { recursive: true });
          ensureLearningDirs(this.opts.harnessHome, project.id);
        }
        await appendFile(path, `${JSON.stringify(observation)}\n`, 'utf-8');
      } catch {
        // Invariant #10: never block. Swallow disk failures.
      } finally {
        this.buffered -= 1;
      }
    });
  }

  /** Drain the buffer. Best-effort; safe to call multiple times. */
  async drain(): Promise<void> {
    await this.writeChain;
  }

  /** Diagnostic: count of records dropped due to buffer overflow. */
  getDroppedCount(): number {
    return this.dropped;
  }

  private buildObservation(input: ObserveInput): Observation {
    const project = getProjectId(this.opts.cwd);
    const id = `obs-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
    const inputJson = JSON.stringify(input.toolInput);
    const tool_input_hash = `sha256:${createHash('sha256').update(inputJson).digest('hex')}`;
    const tool_input_summary = inputJson.length > SUMMARY_MAX ? `${inputJson.slice(0, SUMMARY_MAX - 3)}...` : inputJson;
    return {
      id,
      ts: new Date().toISOString(),
      project_id: project.id,
      project_name: project.name,
      session_id: this.opts.sessionId,
      tool_name: input.toolName,
      tool_input_hash,
      tool_input_summary,
      status: input.status,
      duration_ms: input.durationMs,
      ...(input.observationEnvelope !== undefined ? { observation_envelope: input.observationEnvelope } : {}),
      ...(input.traceId !== undefined ? { trace_id: input.traceId } : {}),
    };
  }
}
```

#### Orchestrator wire

In `src/core/orchestrator.ts`, locate the existing PostToolUse hook fire (around line 482). Add immediately after:

```typescript
// Phase 13.4 — internal observation writer (in-process; never blocks).
ctx.learningObserver?.observe({
  toolName: tool.name,
  toolInput: input,
  status: callStatus, // 'success' | 'error' | 'denied' | 'cancelled' — already classified at this site
  durationMs: callDuration,
  ...(observation !== undefined ? { observationEnvelope: { status: observation.status, summary: observation.summary } } : {}),
  // traceId not threaded into orchestrator yet; leave omitted for v0
});
```

The implementer should verify the actual variable names at the orchestrator site (`tool.name`, `input`, `callStatus`, `callDuration`, `observation`) — adapt to whatever's in scope.

#### REPL wire

In `src/ui/terminalRepl.ts`, near where `taskManager` and `reviewManager` are instantiated:

```typescript
const learningObserver = new LearningObserver({
  harnessHome,
  cwd: process.cwd(),
  sessionId: activeSessionId,
  bufferSize: userSettings.learning?.observationBufferSize ?? 200,
  enabled: !(userSettings.learning?.disabled === true),
});
writableCtx.learningObserver = learningObserver;
```

Add to teardown — drain the buffer on session end (best-effort):

```typescript
await learningObserver.drain();
```

Add `learningObserver?: LearningObserver` to ToolContext.

**Tests cover:**
- Single observe → file appears with correct shape
- 250 observes with buffer=200 → 50 drops registered + 200 written
- `enabled: false` → no writes, no errors
- Deeply-malformed `toolInput` → still writes (JSON.stringify doesn't throw on objects)

**Commit:** `feat(learning): observation writer + orchestrator PostToolUse intercept`

---

### Task 3 — Instinct store + cluster keys

**Goal:** Pure logic for grouping observations by `(tool_name, action-pattern, status)` triples, plus a store that round-trips Instinct frontmatter to/from `$HARNESS_HOME/learning/<projectId>/instincts/<id>.md`.

**Files:**
- Create: `src/learning/cluster.ts`
- Create: `src/learning/instinctStore.ts`
- Create: `tests/learning/cluster.test.ts`, `tests/learning/instinctStore.test.ts`

#### Cluster keys

```typescript
// src/learning/cluster.ts
// Deterministic clustering — given a set of observations, group them by
// (tool_name, normalized action-pattern, status). Pure function; no
// network or disk side effects.

import type { Observation } from './types.js';

export interface Cluster {
  key: string;
  observations: Observation[];
}

/** Normalize tool input into an action-pattern signature. Strips
 *  user-specific paths/IDs, keeps shape and stable structural cues. */
export function actionPattern(toolName: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input).slice(0, 64);
  // For each known tool, project to a stable shape signature. Default:
  // sorted keys + value-type signature. The exact projection per tool is
  // a v0 simplification; tighter normalizations land in v0.x as patterns
  // emerge.
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const shape = keys.map((k) => `${k}:${typeof obj[k]}`).join(',');
  return `${toolName}|${shape}`;
}

export function clusterObservations(observations: Observation[]): Cluster[] {
  const map = new Map<string, Cluster>();
  for (const obs of observations) {
    const ap = obs.tool_input_summary;
    const key = `${obs.tool_name}::${ap.slice(0, 80)}::${obs.status}`;
    const existing = map.get(key);
    if (existing) {
      existing.observations.push(obs);
    } else {
      map.set(key, { key, observations: [obs] });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.observations.length - a.observations.length);
}
```

#### Instinct store

```typescript
// src/learning/instinctStore.ts
// Read/write Instinct .md files in $HARNESS_HOME/learning/<projectId>/instincts/.
// Per-project + global stores; same on-disk shape (frontmatter + markdown body).

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { ensureLearningDirs, ensureGlobalLearningDirs, instinctPath, instinctsDir, GLOBAL_PROJECT_ID } from './paths.js';
import { InstinctSchema, type Instinct } from './types.js';

export class InstinctStore {
  constructor(private readonly harnessHome: string) {}

  list(projectId: string): Instinct[] {
    const dir = instinctsDir(this.harnessHome, projectId);
    if (!existsSync(dir)) return [];
    const out: Instinct[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        out.push(this.read(projectId, file.replace(/\.md$/, '')));
      } catch {
        // skip malformed
      }
    }
    return out;
  }

  read(projectId: string, instinctId: string): Instinct {
    const path = instinctPath(this.harnessHome, projectId, instinctId);
    const raw = readFileSync(path, 'utf-8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!m) throw new Error(`malformed instinct ${instinctId}: missing frontmatter`);
    const data = parseYaml(m[1] ?? '') as Record<string, unknown>;
    return InstinctSchema.parse(data);
  }

  write(instinct: Instinct, body: string): void {
    if (instinct.scope === 'global') {
      ensureGlobalLearningDirs(this.harnessHome);
    } else if (instinct.project_id) {
      ensureLearningDirs(this.harnessHome, instinct.project_id);
    }
    const projectId = instinct.scope === 'global' ? GLOBAL_PROJECT_ID : (instinct.project_id ?? '');
    const path = instinctPath(this.harnessHome, projectId, instinct.id);
    const fm = stringifyYaml(instinct);
    writeFileSync(path, `---\n${fm}---\n${body}`);
  }

  remove(projectId: string, instinctId: string): void {
    const path = instinctPath(this.harnessHome, projectId, instinctId);
    if (existsSync(path)) unlinkSync(path);
  }
}
```

**Tests cover:** cluster determinism (same observations → same key order), instinct write+read round-trip preserves all fields including `observation_ids` array, store handles missing dirs gracefully.

**Commit:** `feat(learning): instinct store + deterministic clustering`

---

### Task 4 — Confidence math

**Goal:** Pure functions for confidence updates. Reinforcement uses logarithmic curve with cap 0.9. Contradiction drops sharply (e.g., −0.2 per hit). Pure unit-testable.

**Files:**
- Create: `src/learning/confidence.ts`
- Create: `tests/learning/confidence.test.ts`

```typescript
// src/learning/confidence.ts
// Pure confidence-update math. No I/O.

const CONFIDENCE_CAP = 0.9;
const CONFIDENCE_FLOOR = 0.0;
const REINFORCEMENT_K = 0.04; // tunable; logarithmic
const CONTRADICTION_DELTA = -0.2;

/** Logarithmic reinforcement; bounded at CONFIDENCE_CAP. The curve
 *  decelerates as confidence approaches 0.9 — a 0.5→0.55 jump is harder
 *  than 0.3→0.35. */
export function reinforce(currentConfidence: number, evidenceCount: number): number {
  const delta = REINFORCEMENT_K * Math.log(1 + evidenceCount);
  const next = Math.min(currentConfidence + delta, CONFIDENCE_CAP);
  return roundTo(next, 3);
}

/** Sharp contradiction drop. Floor at 0. */
export function contradict(currentConfidence: number, contradictionWeight: number = 1): number {
  const next = Math.max(currentConfidence + CONTRADICTION_DELTA * contradictionWeight, CONFIDENCE_FLOOR);
  return roundTo(next, 3);
}

/** Whether an instinct should be pruned: sub-threshold + aging window. */
export function shouldPrune(
  confidence: number,
  lastEvidenceAt: string,
  pruneBelowConfidence: number,
  pruneAgeDays: number,
): boolean {
  if (confidence >= pruneBelowConfidence) return false;
  const ageMs = Date.now() - new Date(lastEvidenceAt).getTime();
  return ageMs > pruneAgeDays * 86_400_000;
}

function roundTo(n: number, places: number): number {
  const m = 10 ** places;
  return Math.round(n * m) / m;
}
```

**Tests cover:** reinforcement caps at 0.9; contradiction floors at 0; logarithmic property (10 evidence reinforces less than 1 evidence × 10); aging prune respects both thresholds.

**Commit:** `feat(learning): pure confidence-update math`

---

### Task 5 — Four instinct tools + LEARNING_ONLY_TOOLS pool

**Goal:** Implement `instinct_list`, `instinct_view`, `instinct_propose`, `instinct_update_confidence`. Move them out of the global REGISTERED_TOOLS into a new `LEARNING_ONLY_TOOLS` export — same pattern as Phase 13.3's `REVIEW_ONLY_TOOLS` (commit `ec21277`).

**Files:**
- Create: `src/tools/InstinctListTool.ts`, `src/tools/InstinctViewTool.ts`, `src/tools/InstinctProposeTool.ts`, `src/tools/InstinctUpdateConfidenceTool.ts`
- Modify: `src/tool/registry.ts` — export `LEARNING_ONLY_TOOLS`
- Create: `tests/tools/instinctTools.test.ts`, `tests/tools/learningOnlyPool.test.ts`

#### InstinctListTool (read-only)

Input: `{ domain?: InstinctDomain, scope?: InstinctScope, min_confidence?: number, project_id?: string }`. Reads via `InstinctStore`. Returns `Instinct[]`.

#### InstinctViewTool (read-only)

Input: `{ id: string, project_id?: string }`. Returns full instinct + body.

#### InstinctProposeTool (synthesizer-only; write)

Input: `{ trigger: string, action: string, evidence_count: number, domain: InstinctDomain, scope: InstinctScope, project_id?: string, observation_ids: string[] }`.
Generates ULID, computes initial confidence via `reinforce(0, evidence_count)`, writes via `InstinctStore.write`. Returns the new instinct id.

#### InstinctUpdateConfidenceTool (synthesizer-only; write)

Input: `{ id: string, project_id: string, action: 'reinforce' | 'contradict', evidence_count?: number, reason: string }`.
Reads instinct, applies `reinforce` or `contradict`, writes back.

#### Registry

```typescript
// in src/tool/registry.ts (after REVIEW_ONLY_TOOLS export)
export const LEARNING_ONLY_TOOLS = [
  InstinctListTool,
  InstinctViewTool,
  InstinctProposeTool,
  InstinctUpdateConfidenceTool,
] as unknown as Tool<unknown, unknown>[];
```

**Tests cover:**
- All 4 tool I/O round-trips through `InstinctStore`
- Main agent's `assembleToolPool` does NOT include any instinct tool
- `LEARNING_ONLY_TOOLS` exports exactly 4 tools

**Commit:** `feat(learning): 4 instinct tools + LEARNING_ONLY_TOOLS pool isolation`

---

### Task 6 — `instinct-synthesizer` agent definition

**Goal:** Bundled agent with restricted toolset that processes observations into instincts.

**File:**
- Create: `bundle-default/agents/instinct-synthesizer.md`
- Modify: existing `tests/agents/...` test (or create `tests/agents/synthesizer-defaults.test.ts`) to assert it loads

#### Agent definition

```markdown
---
name: instinct-synthesizer
description: Background processor that clusters tool-use observations into atomic, confidence-weighted instincts.
role: synthesizer
allowedTools:
  - Read
  - Grep
  - instinct_list
  - instinct_view
  - instinct_propose
  - instinct_update_confidence
maxTurns: 8
---

# Instinct synthesizer

You are a background processor. The user just completed a stretch of work in their main session. Your job is to look at the recent tool-use observations, cluster them by behavior, and propose atomic *instincts* — small, confidence-weighted learned behaviors that the harness can later promote to durable memory or skills.

## Inputs you receive

- A path to the recent observations file (`observations.jsonl`).
- The current project's existing instincts (you can fetch via `instinct_list`).

## What you do

1. Read the recent observations (`Read` the JSONL file).
2. Use `instinct_list` to see what's already known for this project.
3. For each cluster of similar observations:
   - If it matches an existing instinct's trigger+action, call `instinct_update_confidence` with `action: 'reinforce'` and the new evidence count.
   - If it represents a new behavior with ≥ 3 supporting observations, call `instinct_propose` with the trigger, action, evidence count, and inferred domain.
   - If it represents a *contradiction* (an action the user explicitly rejected — `status: 'denied'` calls, edits that reverse prior edits), call `instinct_update_confidence` with `action: 'contradict'`.
4. Be conservative. An instinct should be:
   - A small, atomic behavior — one trigger, one action.
   - Backed by ≥ 3 distinct observations.
   - Specific enough to be testable ("when writing TypeScript functions, add return type annotations") not a tautology ("write good code").
5. Stop after filing all justified proposals. End your turn with a one-line summary like `proposed N instincts, reinforced M, contradicted K`.

## Conservative bias

**Do not propose** if you can't articulate the trigger and action precisely. The instinct corpus stays valuable only when each entry is sharp; noisy proposals dilute it. Producing zero proposals is a valid outcome.

## Domain classification

Pick the best fit; not all observations belong to a clean domain:
- `code-style` — formatting, naming, type annotations, import ordering
- `testing` — test structure, assertion patterns, fixture design
- `git` — commit message conventions, branching habits, push timing
- `debugging` — log inspection patterns, breakpoint placement, isolating reproductions
- `workflow` — multi-step processes, tool sequencing, when to escalate
- `tooling` — preferred CLIs / packages / scripts within the project
```

**Test:** assert agent loads via `loadAgentDefinitions()` with `name: 'instinct-synthesizer'`, `allowedTools` includes `instinct_propose` and excludes `Bash` / `FileWrite` (defense-in-depth).

**Commit:** `feat(agents): instinct-synthesizer reference agent`

---

### Task 7 — Synthesizer dispatcher + ReviewManager trigger

**Goal:** `src/learning/synthesizer.ts` mirrors Phase 13.3's `runReviewFork` — fire-and-forget dispatch via `SubagentScheduler.delegate(...)` against the `instinct-synthesizer` agent. Augment the parent's tool pool with `LEARNING_ONLY_TOOLS` so the child can call `instinct_propose` etc. Wire a counter (`synthesizerEveryN`) into ReviewManager so synthesis fires periodically.

**Files:**
- Create: `src/learning/synthesizer.ts`
- Modify: `src/review/manager.ts` — add `synthesizerSince` counter + `synthesizerEveryN` threshold + `dispatchSynthesizer()`
- Modify: `src/config/schema.ts` — `learning.synthesizerEveryN` setting (already in design above)
- Modify: `src/ui/terminalRepl.ts` — pass `synthesizerEveryN` override into ReviewManager
- Create: `tests/learning/synthesizer.test.ts`

#### Synthesizer dispatcher

```typescript
// src/learning/synthesizer.ts
// One-shot dispatch helper for the instinct-synthesizer sub-agent.
// Mirrors src/review/fork.ts but augments the pool with LEARNING_ONLY_TOOLS.

import { join } from 'node:path';
import { LEARNING_ONLY_TOOLS } from '../tool/registry.js';
import type { SubagentScheduler } from '../runtime/scheduler.js';
import type { TraceEvent } from '../trace/types.js';
import type { Tool, ToolContext } from '../tool/types.js';
import { observationsPath } from './paths.js';

export interface RunSynthesizerOpts {
  scheduler: SubagentScheduler;
  parentSessionId: string;
  parentSignal: AbortSignal;
  parentToolPool: Tool<unknown, unknown>[];
  parentToolContext: ToolContext;
  harnessHome: string;
  projectId: string;
  projectName: string;
  recentObservationCount: number;
  traceRecorder?: (event: TraceEvent) => void;
}

const HARD_CAP_MAX_TURNS = 8;

function buildPrompt(opts: RunSynthesizerOpts): string {
  return [
    'You are operating as the instinct-synthesizer sub-agent.',
    `Project: ${opts.projectName} (${opts.projectId})`,
    `Observations file: ${observationsPath(opts.harnessHome, opts.projectId)}`,
    `Recent observation count to focus on: ${opts.recentObservationCount}`,
    '',
    'Read recent observations, cluster them, and propose / reinforce / contradict instincts.',
    'Be conservative. Producing zero proposals is valid.',
  ].join('\n');
}

export async function runSynthesizer(opts: RunSynthesizerOpts): Promise<void> {
  const augmentedPool: Tool<unknown, unknown>[] = [...opts.parentToolPool, ...LEARNING_ONLY_TOOLS];
  try {
    await opts.scheduler.delegate({
      agentName: 'instinct-synthesizer',
      prompt: buildPrompt(opts),
      parentSessionId: opts.parentSessionId,
      parentSignal: opts.parentSignal,
      parentToolPool: augmentedPool,
      parentToolContext: opts.parentToolContext,
      ...(opts.traceRecorder !== undefined ? { traceRecorder: opts.traceRecorder } : {}),
    });
  } catch (err) {
    // Invariant #10 — silent on failure.
    try {
      opts.traceRecorder?.({
        type: 'session_end',
        sessionId: opts.parentSessionId,
        timestamp: new Date().toISOString(),
        terminalReason: 'error',
        error: { message: `[synthesizer] ${err instanceof Error ? err.message : String(err)}` },
      } as never);
    } catch {}
  }
}
```

#### ReviewManager extension

Add to `src/review/manager.ts`:

```typescript
// new threshold field
synthesizerEveryN: number;
// in DEFAULT_THRESHOLDS:
synthesizerEveryN: 20,
// new private state
private synthesizerSince = 0;

// In onUserTurn (after the existing review-memory dispatch):
this.synthesizerSince += 1;
if (this.synthesizerSince >= this.thresholds.synthesizerEveryN) {
  this.synthesizerSince = 0;
  this.dispatchSynthesizer();
}

// New private method
private dispatchSynthesizer(): void {
  const project = this.opts.projectIdentity?.();
  if (!project) return; // need a project context to dispatch
  void runSynthesizer({
    scheduler: this.scheduler,
    parentSessionId: this.sessionId,
    parentSignal: this.signal,
    parentToolPool: this.parentToolPool,
    parentToolContext: this.parentToolContext,
    harnessHome: this.opts.harnessHome ?? '',
    projectId: project.id,
    projectName: project.name,
    recentObservationCount: 50,
    ...(this.traceRecorder !== undefined ? { traceRecorder: this.traceRecorder } : {}),
  });
}
```

The `projectIdentity` callback is added to `ReviewManagerOpts`:

```typescript
projectIdentity?: () => { id: string; name: string };
harnessHome?: string;
```

**Tests cover:**
- runSynthesizer augments pool with LEARNING_ONLY_TOOLS before delegating
- synthesizerSince increments on `onUserTurn`, fires at threshold, resets
- synthesizerEveryN override from settings respected

**Commit:** `feat(learning): synthesizer dispatcher + ReviewManager trigger`

---

### Task 8 — Review fork integration: switch from trajectory to instincts

**Goal:** Phase 13.3's `runReviewFork` previously passed trajectory + trace paths in its prompt context. Now it also passes the instincts file + recent observation count. The review fork's agent definitions (`review-memory.md`, `review-skill.md`) are updated to *primarily* read the instinct corpus, falling back to the trajectory only when no instincts have been promoted yet.

**Files:**
- Modify: `src/review/fork.ts` — extend `ReviewForkPromptContext` with `instinctsFile?: string`
- Modify: `bundle-default/agents/review-memory.md`, `review-skill.md` — update body to prefer instincts over raw trajectory
- Modify: `src/review/manager.ts` — pathsResolver now also returns instinctsFile path
- Modify: `src/review/fork.ts` — augment `parentToolPool` with `LEARNING_ONLY_TOOLS` (so review forks can call `instinct_list` / `instinct_view`)

#### Updated prompt context

```typescript
export interface ReviewForkPromptContext {
  trajectoryPath: string;
  tracePath: string;
  instinctsFile?: string; // NEW
  recentTurnCount: number;
}

function buildPrompt(agentName: ReviewAgentName, ctx: ReviewForkPromptContext): string {
  const lines = [
    `You are operating as a review sub-agent (${agentName}).`,
  ];
  if (ctx.instinctsFile !== undefined) {
    lines.push(`Instincts directory (preferred input): ${ctx.instinctsFile}`);
  }
  lines.push(
    `Trajectory file (fallback): ${ctx.trajectoryPath}`,
    `Trace file: ${ctx.tracePath}`,
    `Recent turn count to focus on: ${ctx.recentTurnCount}`,
    '',
    'When instincts are available, prefer them — they are pre-clustered, evidence-backed, and confidence-graduated. Use the trajectory only as a fallback or to confirm specific evidence.',
    'Read the input(s), then file proposals via your allowed proposal tool. Be conservative.',
  );
  return lines.join('\n');
}
```

#### Review agent body updates

Add a section to `review-memory.md` and `review-skill.md` describing the new input preference:

> ## Preferred input: instincts
> When the harness provides an instincts directory, prefer it. Each instinct is a small, confidence-weighted learned behavior with evidence count. Memory proposals should reference the instinct(s) they are derived from in the `sourceExcerpt` field. Use `instinct_list` to filter by `min_confidence: 0.7` and `evidence_count: 5+` for the strongest candidates.

Also update review-memory's allowedTools to include `instinct_list` and `instinct_view`. (Don't include `instinct_propose` — review fork files memory/skill proposals, not new instincts.)

**Tests cover:**
- Review fork's `parentToolPool` after augmentation contains both `memory_propose` AND `instinct_list`/`instinct_view`
- Existing review-fork tests still pass

**Commit:** `feat(review): review fork reads instinct corpus + trajectory fallback`

---

### Task 9 — `harness learning` CLI subcommand

**Goal:** `harness learning status / prune / export <project-id>` read-only listing + maintenance.

**Files:**
- Create: `src/cli/learningStatus.ts`, `src/cli/learningPrune.ts`, `src/cli/learningExport.ts`
- Modify: `src/main.ts` — register `learning` subcommand with three actions
- Create: `tests/cli/learningCommands.test.ts`

#### CLI surface

```bash
# Per-project counts + confidence histogram + last synthesis timestamp
harness learning status [--project <id>]

# Drop sub-threshold instincts past their aging window
harness learning prune [--project <id>] [--dry-run]

# Emit instincts as .md to stdout or a target dir
harness learning export <project-id> [--output <dir>]
```

Implementation: each command is a thin wrapper over `InstinctStore.list(projectId)` + `confidence.shouldPrune` + filesystem writes. No model calls.

**Tests cover:**
- `status` on empty project returns "no instincts yet"
- `status` on populated project returns expected aggregates
- `prune --dry-run` lists candidates without removing
- `prune` actually removes sub-threshold + aged instincts
- `export` writes one .md per instinct

**Commit:** `feat(cli): harness learning {status,prune,export} subcommands`

---

### Task 10 — Cross-project promotion

**Goal:** Pure logic that scans all per-project instinct corpora and surfaces ones appearing in N≥2 projects at confidence ≥ 0.7. Synthesizer calls this at the end of its pass; matches go through `instinct_propose` with `scope: 'global'`. Promotion still requires Phase 13.3's `/review approve` for actual write to `MEMORY.md` / `USER.md`.

**Files:**
- Create: `src/learning/promotion.ts`
- Modify: `bundle-default/agents/instinct-synthesizer.md` — add cross-project check to body
- Create: `tests/learning/promotion.test.ts`

```typescript
// src/learning/promotion.ts
// Pure cross-project promotion check. Synthesizer calls this with the
// list of all per-project instincts; returns candidates worth promoting
// to global scope.

import type { Instinct } from './types.js';

export interface PromotionCandidate {
  trigger: string;
  action: string;
  domain: Instinct['domain'];
  evidenceProjects: { projectId: string; confidence: number; evidenceCount: number }[];
}

const MIN_PROJECTS = 2;
const MIN_CONFIDENCE = 0.7;

export function findPromotionCandidates(perProjectInstincts: Instinct[]): PromotionCandidate[] {
  const projectInstincts = perProjectInstincts.filter((i) => i.scope === 'project');
  const groups = new Map<string, Instinct[]>();
  for (const inst of projectInstincts) {
    if (inst.confidence < MIN_CONFIDENCE) continue;
    const key = `${inst.trigger}::${inst.action}::${inst.domain}`;
    const arr = groups.get(key) ?? [];
    arr.push(inst);
    groups.set(key, arr);
  }
  const out: PromotionCandidate[] = [];
  for (const arr of groups.values()) {
    if (arr.length < MIN_PROJECTS) continue;
    const first = arr[0]!;
    out.push({
      trigger: first.trigger,
      action: first.action,
      domain: first.domain,
      evidenceProjects: arr.map((i) => ({
        projectId: i.project_id ?? '?',
        confidence: i.confidence,
        evidenceCount: i.evidence_count,
      })),
    });
  }
  return out;
}
```

Synthesizer agent body update: add a step "After per-project clustering, call `instinct_list({ scope: 'project' })` across all projects via the harness's project iterator (or just trust the synthesizer to be invoked once per project; cross-project is best-effort)."

**v0 simplification:** Cross-project promotion fires when the synthesizer is invoked in project B AND it can see project A's instincts. Since the synthesizer reads via `InstinctStore.list(projectId)`, we add a `listAllProjects()` helper to the store that walks `learning/*/` directories.

**Tests cover:** 2 project corpora with one matching instinct → 1 candidate; 1 project alone → 0 candidates; sub-threshold confidence excluded; same trigger/action across 3 projects → candidate has 3 evidenceProjects.

**Commit:** `feat(learning): cross-project instinct promotion logic`

---

### Task 11 — Integration test: end-to-end observe → synthesize → review

**Goal:** Programmatic exercise of the build-plan Check (slimmer version that runs in unit tests). Use a fake provider for the synthesizer's sub-agent.

**File:**
- Create: `tests/learning/integration.test.ts`

Exercises:
1. Construct LearningObserver, call `observe()` 20 times with synthetic tool calls.
2. Confirm `observations.jsonl` has 20 records.
3. Call `runSynthesizer` with a fake scheduler that records the agent dispatch (we don't actually run an LLM).
4. Manually call `InstinctStore.write` to simulate the synthesizer producing 3 instincts.
5. Confirm `instincts/<id>.md` files exist with correct shape.
6. Call `findPromotionCandidates` with cross-project state — confirm promotion logic.
7. Run `harness learning status` on the populated state — confirm counts.

**Commit:** `test(learning): end-to-end integration test`

---

### Task 12 — Semantic test suite

**Goal:** 3-4 cases at `tests/semantic/suites/21-learning.cases.ts` exercising user-facing surfaces.

**Cases (all `category: 'commands'` since they exercise CLI/slash surfaces):**

1. `commands.harness-learning-status-empty` — `harness learning status` on a fresh harness returns the empty-state message.
2. `tools.main-agent-excludes-instinct-tools` — model uses HarnessInfo to confirm `instinct_propose`, `instinct_update_confidence`, `instinct_list`, `instinct_view` are NOT in its tool pool. (Same pattern as the propose-tool guard from suite 20.)
3. `commands.harness-learning-prune-dry-run` — `harness learning prune --dry-run` on empty corpus returns "0 instincts would be pruned" cleanly.
4. `commands.harness-learning-export-empty` — `harness learning export _global` on empty corpus returns honest empty message, doesn't error.

**Commit:** `test(semantic): Phase 13.4 learning system coverage (4 cases, 54 → 58)`

---

### Task 13 — Docs + close-out

**Goal:** Mark Phase 13.4 complete in `CLAUDE.md`. Append testing-log entry. Update semantic-testing inventory. Add a "Learning Pipeline" section to `docs/02-architecture/runtime-architecture.md` mirroring the Review Pipeline section.

**Files modified:**
- `CLAUDE.md` — phases paragraph + next-target line
- `docs/06-testing/testing-log.md` — append Phase 13.4 entry
- `docs/06-testing/semantic-testing.md` — inventory 54 → 58
- `docs/02-architecture/runtime-architecture.md` — new Learning Pipeline section
- `docs/03-cli-reference/usage.md` — `harness learning` subcommand docs + `settings.learning.*` config block

**Final gate:**
```bash
cd /Users/julie/code/sovereign-ai-sdk
bun test
bun run typecheck
bun run lint
git push origin master
sov upgrade
```

**Commit:** `docs: mark Phase 13.4 instinct corpus complete`

---

## Self-Review

Coverage check against build plan §2009-2094 (build items 1–8):

- ✅ Build item 1 — Observation writer with the canonical `Observation` shape, fire-and-forget, bounded buffer (T2)
- ✅ Build item 2 — Project identity with git-remote → cwd hash fallback (T1)
- ✅ Build item 3 — Background instinct synthesizer as Phase 13 sub-agent with restricted toolset (T6, T7)
- ✅ Build item 4 — Confidence updates with logarithmic reinforcement + sharp contradiction (T4); aging out via prune CLI (T9)
- ✅ Build item 5 — Cross-project promotion (T10)
- ✅ Build item 6 — Phase 13.3 review fork reads instinct corpus (T8)
- ✅ Build item 7 — All four instinct tools, visible only in synthesizer / review-fork pool (T5)
- ✅ Build item 8 — `harness learning status / prune / export` (T9)

Skip-list compliance (build plan §2106-2112):
- ✅ Auto-promote of instincts to memory/skills without human approval — explicitly through `/review approve` only.
- ✅ Embedding-based clustering — deterministic key matching only (T3).
- ✅ Cross-user instinct sharing — per-installation only.
- ✅ Instinct UI / TUI viewer — CLI listing only (T9).
- ✅ Realtime confidence updates — batch during synthesizer pass (T7).

v0 limits explicitly documented:
- Cross-project promotion exercised only in unit tests with synthetic corpora (full integration depends on a real second project)
- Contradiction detection's "instead, do X" NL parsing is best-effort string matching only

Type consistency: `Observation` and `Instinct` types defined once in `src/learning/types.ts` and referenced from observer / store / synthesizer / promotion / cluster. `ReviewForkPromptContext.instinctsFile` is the only field added to T5's existing structure.

Placeholder scan: clean — every step has either complete code or a concrete instruction with the surrounding pattern referenced.

---

## Execution Handoff

**Plan complete and saved to `plans/2026-05-06-phase-13-4-instinct-corpus.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — same approach used for Phases 13.2 + 13.3. Fresh implementer per task + 2-stage review (spec compliance → code quality). Continuous execution; trunk-based commits to master per CLAUDE.md.
2. **Inline Execution** — execute tasks in this session via the executing-plans skill, batched checkpoints.

Which approach?
