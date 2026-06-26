# Learning-Loop Spike — Phase 1 · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open learning loop on this harness behind the four-port contract, and prove via an eval that a lesson available in session N changes behavior in session N+1 with **no human approval** — per the design at `specs/2026-06-03-portable-learning-layer-adapter-1-design.md` (decisions D1–D15) and the canonical spike spec in `sovereign-ai-docs`.

**Architecture:** A new sealed `src/learning-layer/` module exposes two host-facing APIs (**Observe**, **Recall**) and depends on two host-provided ports (**Reason**, **Persist**). Adapter #1 (`src/learning-layer/adapters/harness/`) binds those to this harness: Recall is spliced into the latest user message in `query()` (mirroring the existing MEMORY.md injection), the server turns route is fixed to actually pass the injection hooks, synthesis yield is repaired (confidence curve + clustering + cadence), and a with-vs-without eval scores correctness flips on curated scenarios.

**Tech Stack:** TypeScript on Bun. Bun's built-in test runner. Zod for config. The existing semantic framework (`sov drive` + pluggable judges) for the eval. MockProvider for deterministic wiring tests.

---

## Investigation findings (verified against the codebase)

These supersede the spec's design-level wording where implementation reality is narrower. Tasks reflect the actual code paths.

1. **Recall injection point is `src/core/query.ts:72-74`** — `injectMemoryIntoLatestUserMessage` runs once before turn 0, gated on `params.memoryManager`. The recall splice goes immediately after it. `QueryParams` is at **`src/core/types.ts:112`** (`memoryManager?: MemoryRuntime`).

2. **Recall is passed as a bound thunk, not the raw port** (refines D5/D6). `query()` is project-agnostic; threading `projectId` into core is ugly. Instead `QueryParams` gains `recall?: RecallTurn` where `type RecallTurn = (latestUserText: string | undefined) => Promise<RecallResult>`. `sessionContext` builds the thunk bound to the session's `projectScope`, so `query()` just calls it. `RecallResult` is imported (type-only) from `src/learning-layer/ports.js` into `src/core/types.ts` — a host→layer-public-types dependency, which the contract allows (the layer never imports core).

3. **The server turns route omits the injection hooks** (D6, load-bearing). `src/server/routes/turns.ts:557-591` builds `query({...})` without `memoryManager` *or* any recall hook. Phase 1 adds **both** `memoryManager: sessionCtx.memoryManager` and `recall: sessionCtx.recall`. Without this, `sov drive` (→ Hono server → this route) never injects, and the eval can't observe Recall.

4. **`memoryManager` is per-session**, built at `src/server/sessionContext.ts:253` via `createDefaultMemoryManager(runtime.harnessHome, projectScope)`, declared on the session-context type at `:97`, exposed at `:267`. The recall thunk is built and exposed the same way.

5. **`InstinctStore` is synchronous** (`src/learning/instinctStore.ts`: `writeFileSync`/`readFileSync`/`unlinkSync`), API `list(projectId)`, `read`, `readWithBody`, `write(instinct, body)`, `remove`, `listAllProjects()`. Making it depend on the async `PersistPort` would ripple through ~8 callers (4 instinct tools + 3 `learning` CLIs + Recall). **Refinement of D7:** Phase 1 extracts a **pure serde** (`serializeInstinct`/`parseInstinct`) from the existing store (no behavior change), then builds a separate **Persist-backed reader** (`readInstincts`) for Recall over `PersistPort` + that serde. The full async migration is Phase 2.

6. **The confidence curve is `reinforce(currentConfidence, evidenceCount)` = `min(start + k·ln(1+n), cap)`** with `k=0.04`, `cap=0.9` (`src/learning/confidence.ts`). `reinforce(0, n)=0.7` needs `n ≈ 4·10⁷`. `ConfidenceTuning` already exists (`reinforcementCurveK`, `confidenceCap`, `initialConfidenceBaseline`). `InstinctProposeTool.ts:66` calls `reinforce(0, evidence_count)`. The fix adds an **absolute saturating** `confidenceFromEvidence(totalEvidenceCount)` and routes propose/update through it.

7. **The cluster key is `tool_name::tool_input_summary[:80]::status`** (`src/learning/cluster.ts:20-23`) — verbatim args fragment clusters. Fix: normalize the summary (paths/numbers/quoted-strings → placeholders) before keying.

8. **Synthesis cadence + bias** live in `src/review/manager.ts` (counters: every 20 user turns / 50 tool iterations → `dispatchSynthesizer`), `src/learning/synthesizer.ts` (fire-and-forget, swallows failures, prompt says "producing zero is valid"), and `bundle-default/agents/instinct-synthesizer.md` (`maxTurns: 8`, zero-bias framing). Synthesis is dispatched via `scheduler.delegate({ agentName: 'instinct-synthesizer', ... })` — **kept as-is in Phase 1** (Reason extraction is deferred, D8).

9. **`ComponentKind` in `src/context/budget.ts`** is `system-segment|tool-schema|skill|bundle|memory` — no `instinct`. Add it.

10. **Semantic framework:** suites are `tests/semantic/suites/NN-name.cases.ts` exporting `export const tests: SemanticTest[]`; `SemanticTest` supports `prompt: string | string[]` (multi-turn), `setup` (sandbox files + `home` files + `userConfig`), and `judgeCriteria.{mustSatisfy,shouldNot}`. The runner drives `sov drive` headless (`tests/semantic/framework/driver.ts` `runHarnessSession`). **Next free suite number is 24** (21/22/23 taken).

11. **MockProvider** (`src/providers/mock.ts`) has a static `toolUseScript` for canned tool-use sequences (added in the task-routing phase) — used for the deterministic Recall wiring test (D14).

12. **Config:** the `learning` block is `src/config/schema.ts:318` (`reinforcementCurveK` at :342). Add a nested `recall` object + the new curve/cadence knobs here.

---

## File structure

### Files to create

| Path | Purpose |
|---|---|
| `src/learning-layer/ports.ts` | The four port interfaces + shared `readonly` types. The only file host code imports from the layer. |
| `src/learning-layer/index.ts` | `createLearningLayer(deps)` → `LearningLayer` (Observe + Recall) over in-box machinery. |
| `src/learning-layer/recall/assemble.ts` | Pure `assembleLessons(input)` — relevance match · confidence sort · budget. |
| `src/learning-layer/recall/format.ts` | Pure `formatRecallSnapshot(lessons)` — fenced `<learned-context>` block. |
| `src/learning-layer/recall/readInstincts.ts` | Persist-backed instinct reader (`PersistPort` + serde). |
| `src/learning-layer/adapters/harness/persistFs.ts` | `createFsPersist(harnessHome)` — FS `PersistPort` over `$HARNESS_HOME`. |
| `src/learning-layer/adapters/harness/reasonProvider.ts` | `createProviderReason(provider, model)` — thin `ReasonPort` (D8 seam). |
| `src/learning-layer/eval/score.ts` | Pure correctness-flip + efficiency scorer. |
| `src/learning-layer/eval/runner.ts` | Paired-arm (with/without) eval runner over the semantic driver. |
| `src/learning-layer/eval/scenarios/index.ts` | Track-A curated scenarios + Track-B real-synthesis scenario. |
| `src/learning/instinctSerde.ts` | Pure `serializeInstinct`/`parseInstinct` (extracted from `InstinctStore`). |
| `src/core/recallInjection.ts` | Host-side `injectRecallIntoLatestUserMessage` (mirrors `src/memory/injection.ts`). |
| `tests/learning-layer/ports.test.ts` | Shape/construction lock. |
| `tests/learning-layer/persistFs.test.ts` | Round-trip in a temp dir. |
| `tests/learning-layer/reasonProvider.test.ts` | `complete()` over MockProvider. |
| `tests/learning-layer/readInstincts.test.ts` | Reader over a seeded temp corpus. |
| `tests/learning-layer/recall.assemble.test.ts` | Ranking/budget. |
| `tests/learning-layer/recall.format.test.ts` | Fence formatting. |
| `tests/learning-layer/index.test.ts` | Layer `recall()` end-to-end (Persist→assemble→format). |
| `tests/learning-layer/eval.score.test.ts` | Scorer logic. |
| `tests/learning/instinctSerde.test.ts` | Serde round-trip. |
| `tests/core/recallInjection.test.ts` | Splice behavior (no mutation). |
| `tests/server/turns.recall.test.ts` | Deterministic MockProvider wiring (D14) + server-route memory-fix. |
| `tests/semantic/suites/24-learning-recall.cases.ts` | Real-LLM recall-behavior cases. |
| `docs/07-history/state/2026-06-03-learning-loop-spike-phase-1.md` | Close-out snapshot. |

### Files to modify

| Path | Change |
|---|---|
| `src/learning/instinctStore.ts` | Re-import the extracted serde (no behavior change). |
| `src/learning/confidence.ts` | Add `confidenceFromEvidence` + `evidenceSaturation` tuning. |
| `src/learning/cluster.ts` | Normalize the cluster key. |
| `src/tools/InstinctProposeTool.ts` | Use `confidenceFromEvidence(evidence_count)`. |
| `src/tools/InstinctUpdateConfidenceTool.ts` | Recompute confidence from total evidence. |
| `src/review/manager.ts` | End-of-session synthesis trigger when ≥N new observations. |
| `src/learning/synthesizer.ts` | Surface failures (assertable status); stop swallowing. |
| `bundle-default/agents/instinct-synthesizer.md` | Soften the zero-bias framing; raise `maxTurns`. |
| `src/context/budget.ts` | Add `'instinct'` `ComponentKind`. |
| `src/config/schema.ts` | Add `learning.recall` + `evidenceSaturation` + `synthesizeOnSessionEndAfter`. |
| `src/core/types.ts` | Add `recall?: RecallTurn` to `QueryParams`; `RecallTurn` type. |
| `src/core/query.ts` | After memory injection, call `params.recall` + splice. |
| `src/server/runtime.ts` | Construct the learning layer (adapter #1) at boot; stash on `Runtime`. |
| `src/server/sessionContext.ts` | Build the per-session `recall` thunk; expose on the session ctx. |
| `src/server/routes/turns.ts` | Pass `memoryManager` **and** `recall` into `query({...})`. |
| `package.json` | `eval:learning` script; version bump. |
| `docs/03-cli-reference/usage.md` | "Learning recall" subsection. |
| `docs/06-testing/testing-log.md` | Phase 1 entry. |
| `CLAUDE.md` + `AGENTS.md` (byte-identical) | State pointer → the new close-out file. |

---

## Conventions for every task

- **Pre-commit gate (required before each commit):** `bun run lint && bun run typecheck && bun run test`. All green (the known 3 env-only learning-test failures from the state snapshot are the only acceptable reds — no *new* failures).
- **TDD:** write the failing test, run it red, implement minimally, run it green, then commit.
- **Imports use `.js` extensions.** Every new `.ts` file starts with a one-line responsibility header comment. No mutation — return new objects (`readonly` types). Every tool via `buildTool()`.
- **Model:** Opus unless a step is marked *Sonnet-eligible* (trivially mechanical, fully specified). **Never Haiku.**
- **Commits:** atomic, conventional (`feat:`/`test:`/`refactor:`/`fix:`/`docs:`/`chore:`), push to `master`.

---

## Task decomposition

19 tasks. Estimates assume subagent-driven execution per the project's calibration memory (~5x faster than human-time). Total estimated subagent wall-time: ~4–6 hours.

### T1 — The four-port contract (`ports.ts`) (~15 min · Opus)

**Files:**
- Create: `src/learning-layer/ports.ts`
- Test: `tests/learning-layer/ports.test.ts`

- [ ] **Step 1: Write the failing test** (locks the public shape — a stub object must satisfy the interfaces).

```typescript
// tests/learning-layer/ports.test.ts
import { describe, expect, test } from 'bun:test';
import type {
  LearningHostDeps, RecallResult, CapturedSession, PersistPort, ReasonPort,
} from '../../src/learning-layer/ports.js';

describe('ports contract', () => {
  test('a minimal host-deps object type-checks', () => {
    const persist: PersistPort = {
      read: async () => null, write: async () => {}, list: async () => [], remove: async () => {},
    };
    const reason: ReasonPort = { complete: async () => 'ok' };
    const deps: LearningHostDeps = { persist, reason };
    expect(typeof deps.persist.read).toBe('function');
  });

  test('RecallResult/CapturedSession are well-formed', () => {
    const r: RecallResult = { injectionText: '', lessons: [] };
    const s: CapturedSession = { sessionId: 's', projectId: 'p', turns: [], terminalReason: 'completed' };
    expect(r.lessons).toEqual([]);
    expect(s.turns).toEqual([]);
  });
});
```

- [ ] **Step 2: Run red** — `bun test tests/learning-layer/ports.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — copy the interface block verbatim from the spec's "The four-port contract" section into `src/learning-layer/ports.ts` (header comment + `TranscriptTurn`, `CapturedSession`, `ToolEvent`, `RecallContext`, `RecalledLesson`, `RecallResult`, `ReasonOptions`, `ObserveApi`, `RecallApi`, `ReasonPort`, `PersistPort`, `LearningHostDeps`, `LearningLayer`).

- [ ] **Step 4: Run green** — `bun test tests/learning-layer/ports.test.ts` → PASS.

- [ ] **Step 5: Commit** — gate, then `git commit -m "feat(learning-layer): define the four-port contract (ports.ts)"`.

### T2 — FS Persist adapter (`persistFs.ts`) (~20 min · Opus)

**Files:**
- Create: `src/learning-layer/adapters/harness/persistFs.ts`
- Test: `tests/learning-layer/persistFs.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning-layer/persistFs.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsPersist } from '../../src/learning-layer/adapters/harness/persistFs.js';

const home = mkdtempSync(join(tmpdir(), 'persist-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('createFsPersist', () => {
  test('write then read round-trips and creates parent dirs', async () => {
    const p = createFsPersist(home);
    await p.write('learning/proj/instincts/a.md', 'hello');
    expect(await p.read('learning/proj/instincts/a.md')).toBe('hello');
  });
  test('read of a missing key returns null', async () => {
    expect(await createFsPersist(home).read('nope/missing.md')).toBeNull();
  });
  test('list returns file keys under a prefix; missing prefix → []', async () => {
    const p = createFsPersist(home);
    await p.write('learning/proj/instincts/b.md', 'x');
    const keys = await p.list('learning/proj/instincts');
    expect(keys).toContain('learning/proj/instincts/a.md');
    expect(keys).toContain('learning/proj/instincts/b.md');
    expect(await p.list('learning/empty')).toEqual([]);
  });
  test('remove is idempotent', async () => {
    const p = createFsPersist(home);
    await p.write('learning/proj/instincts/c.md', 'x');
    await p.remove('learning/proj/instincts/c.md');
    await p.remove('learning/proj/instincts/c.md'); // no throw
    expect(await p.read('learning/proj/instincts/c.md')).toBeNull();
  });
});
```

- [ ] **Step 2: Run red** → FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/learning-layer/adapters/harness/persistFs.ts
// Adapter #1 Persist port — maps named-blob keys to files under $HARNESS_HOME.
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PersistPort } from '../../ports.js';

export function createFsPersist(harnessHome: string): PersistPort {
  const pathFor = (key: string): string => join(harnessHome, key);
  const isEnoent = (err: unknown): boolean =>
    (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  return {
    async read(key) {
      try {
        return await readFile(pathFor(key), 'utf8');
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async write(key, value) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, value, 'utf8');
    },
    async list(prefix) {
      try {
        const entries = await readdir(pathFor(prefix), { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => join(prefix, e.name));
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
    },
    async remove(key) {
      try {
        await unlink(pathFor(key));
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    },
  };
}
```

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(learning-layer): FS Persist adapter (persistFs)"`.

### T3 — Reason adapter seam (`reasonProvider.ts`) (~15 min · Opus)

> D8: defined + thin-bound + tested; **not** yet wired into synthesis. Placing the seam now keeps the layer's construction signature stable for the Phase 3 synthesis migration.

**Files:**
- Create: `src/learning-layer/adapters/harness/reasonProvider.ts`
- Test: `tests/learning-layer/reasonProvider.test.ts`

- [ ] **Step 1: Write the failing test** (use the existing MockProvider; verify it collects streamed text into one string).

```typescript
// tests/learning-layer/reasonProvider.test.ts
import { describe, expect, test } from 'bun:test';
import { MockProvider } from '../../src/providers/mock.js';
import { createProviderReason } from '../../src/learning-layer/adapters/harness/reasonProvider.js';

describe('createProviderReason', () => {
  test('complete() returns the model text for a prompt', async () => {
    const provider = new MockProvider({ responses: ['lesson: prefer bun test'] });
    const reason = createProviderReason(provider, 'mock-model');
    expect(await reason.complete('summarize')).toContain('prefer bun test');
  });
});
```

> Verify `MockProvider`'s constructor/streaming surface in `src/providers/mock.js`; adapt the canned-response setup to match it. The point is: drive `provider.stream({ model, system, messages })`, accumulate `assistant_message`/text deltas, return the string.

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement** — `complete(prompt, opts)` builds a one-user-message request, calls `provider.stream(...)`, accumulates assistant text, returns it. Mirror how `src/core/query.ts:134-153` consumes the stream (assistant_message → text). Honor `opts.system`, `opts.maxTokens`, `opts.temperature`, `opts.signal`.

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(learning-layer): Reason adapter seam over the provider (reasonProvider)"`.

### T4 — Extract instinct serde (no behavior change) (~20 min · Opus)

**Files:**
- Create: `src/learning/instinctSerde.ts`
- Modify: `src/learning/instinctStore.ts`
- Test: `tests/learning/instinctSerde.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning/instinctSerde.test.ts
import { describe, expect, test } from 'bun:test';
import { parseInstinct, serializeInstinct } from '../../src/learning/instinctSerde.js';
import type { Instinct } from '../../src/learning/types.js';

const sample: Instinct = {
  id: 'i1', trigger: 'running tests here', action: 'use bun test',
  confidence: 0.4, evidence_count: 6, domain: 'testing', scope: 'project',
  project_id: 'p', project_name: 'demo',
  created_at: '2026-06-03T00:00:00.000Z', last_evidence_at: '2026-06-03T00:00:00.000Z',
  observation_ids: ['o1'],
};

describe('instinct serde', () => {
  test('serialize → parse round-trips', () => {
    const raw = serializeInstinct(sample, 'body text');
    const { instinct, body } = parseInstinct(raw);
    expect(instinct).toEqual(sample);
    expect(body).toBe('body text');
  });
  test('parse throws on missing frontmatter', () => {
    expect(() => parseInstinct('no frontmatter here')).toThrow();
  });
});
```

> Match `sample` to the real `InstinctSchema` in `src/learning/types.ts` (drop/add fields as needed so the round-trip is exact).

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement** — move the existing encode (`instinctStore.ts` `write`, the `---\n${fm}---\n${body}` construction + its YAML import) and decode (`read`/`readWithBody` + the `FRONTMATTER_RE`) **verbatim** into `serializeInstinct(instinct, body)` / `parseInstinct(raw)`. Then edit `InstinctStore` to call these (read its bytes from FS, hand to `parseInstinct`; `serializeInstinct` then `writeFileSync`). Keep `InstinctStore`'s public API and sync behavior identical.

- [ ] **Step 4: Run green** — `bun test tests/learning/instinctSerde.test.ts` **and** the existing instinct-store/tool tests → all PASS (this proves no behavior change).

- [ ] **Step 5: Commit** — `git commit -m "refactor(learning): extract pure instinct serde from InstinctStore"`.

### T5 — Persist-backed instinct reader (`readInstincts.ts`) (~20 min · Opus)

**Files:**
- Create: `src/learning-layer/recall/readInstincts.ts`
- Test: `tests/learning-layer/readInstincts.test.ts`

- [ ] **Step 1: Write the failing test** (seed a temp corpus via `createFsPersist`, read it back).

```typescript
// tests/learning-layer/readInstincts.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsPersist } from '../../src/learning-layer/adapters/harness/persistFs.js';
import { serializeInstinct } from '../../src/learning/instinctSerde.js';
import { readInstincts } from '../../src/learning-layer/recall/readInstincts.js';
import type { Instinct } from '../../src/learning/types.js';

const home = mkdtempSync(join(tmpdir(), 'read-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const inst = (id: string, over: Partial<Instinct> = {}): Instinct => ({
  id, trigger: `t-${id}`, action: `a-${id}`, confidence: 0.5, evidence_count: 6,
  domain: 'testing', scope: 'project', project_id: 'proj', project_name: 'demo',
  created_at: '2026-06-03T00:00:00.000Z', last_evidence_at: '2026-06-03T00:00:00.000Z',
  observation_ids: [], ...over,
});

describe('readInstincts', () => {
  test('reads project + _global instincts; tolerates a malformed file', async () => {
    const p = createFsPersist(home);
    await p.write('learning/proj/instincts/a.md', serializeInstinct(inst('a'), ''));
    await p.write('learning/_global/instincts/g.md', serializeInstinct(inst('g', { scope: 'global', project_id: null, project_name: null }), ''));
    await p.write('learning/proj/instincts/broken.md', 'garbage');
    const got = await readInstincts(p, 'proj');
    expect(got.map((i) => i.id).sort()).toEqual(['a', 'g']); // broken skipped, not thrown
  });
});
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement** — `readInstincts(persist, projectId)`: `list('learning/'+projectId+'/instincts')` ∪ `list('learning/_global/instincts')`, keep `.md` keys, `persist.read` each, `parseInstinct`, **skip (don't throw) on parse error** (fail-open), return `Instinct[]`. Use the path strings from `src/learning/paths.ts` semantics (`learning/<projectId>/instincts/`, `_global`).

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(learning-layer): Persist-backed instinct reader for Recall"`.

### T6 — Recall assembly (`assemble.ts`) (~25 min · Opus)

**Files:**
- Create: `src/learning-layer/recall/assemble.ts`
- Test: `tests/learning-layer/recall.assemble.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning-layer/recall.assemble.test.ts
import { describe, expect, test } from 'bun:test';
import { assembleLessons } from '../../src/learning-layer/recall/assemble.js';
import type { Instinct } from '../../src/learning/types.js';

const inst = (id: string, trigger: string, confidence: number): Instinct => ({
  id, trigger, action: `do-${id}`, confidence, evidence_count: 6, domain: 'testing',
  scope: 'project', project_id: 'p', project_name: 'd',
  created_at: '2026-06-03T00:00:00.000Z', last_evidence_at: '2026-06-03T00:00:00.000Z',
  observation_ids: [],
});

describe('assembleLessons', () => {
  const instincts = [
    inst('tests', 'running the test suite', 0.4),
    inst('deploy', 'deploying to production', 0.9),
    inst('tests2', 'run tests before commit', 0.5),
  ];
  test('surfaces trigger-relevant lessons, sorted by (relevance, confidence)', () => {
    const out = assembleLessons({ instincts, latestUserText: 'please run the tests', maxLessons: 8, tokenBudget: 1000 });
    const ids = out.map((l) => l.id);
    expect(ids).toContain('tests');
    expect(ids).toContain('tests2');
    expect(ids).not.toContain('deploy'); // irrelevant trigger dropped
  });
  test('empty/undefined user text → no lessons', () => {
    expect(assembleLessons({ instincts, latestUserText: undefined, maxLessons: 8, tokenBudget: 1000 })).toEqual([]);
  });
  test('respects maxLessons and tokenBudget', () => {
    const out = assembleLessons({ instincts, latestUserText: 'run the tests', maxLessons: 1, tokenBudget: 1000 });
    expect(out).toHaveLength(1);
    const tiny = assembleLessons({ instincts, latestUserText: 'run the tests', maxLessons: 8, tokenBudget: 1 });
    expect(tiny).toHaveLength(0); // nothing fits the budget
  });
});
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement** — pure function:
  - tokenize `latestUserText` (lowercase, split on non-word) into a Set; if empty → return `[]`.
  - for each instinct: `relevance = (# trigger tokens present in the user-text set) / (# trigger tokens)`; drop if `relevance <= 0` (or below `input.relevanceFloor ?? 0`).
  - sort by `relevance` desc, then `confidence` desc, then `id` asc (stable/deterministic).
  - take first `maxLessons`; then greedily accumulate while estimated tokens (`Math.ceil(text.length/4)`, mirroring `src/context/budget.ts`) stay within `tokenBudget`, where each lesson's text is `when <trigger> → <action>`.
  - return `RecalledLesson[]` (`{id, trigger, action, confidence}`).

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(learning-layer): deterministic Recall assembly"`.

### T7 — Recall snapshot formatter (`format.ts`) (~10 min · Sonnet-eligible)

**Files:**
- Create: `src/learning-layer/recall/format.ts`
- Test: `tests/learning-layer/recall.format.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning-layer/recall.format.test.ts
import { describe, expect, test } from 'bun:test';
import { formatRecallSnapshot } from '../../src/learning-layer/recall/format.js';

describe('formatRecallSnapshot', () => {
  test('empty lessons → empty string', () => {
    expect(formatRecallSnapshot([])).toBe('');
  });
  test('renders a fenced learned-context block', () => {
    const out = formatRecallSnapshot([{ id: 'a', trigger: 'running tests', action: 'use bun test', confidence: 0.5 }]);
    expect(out).toContain('NOT new user input');
    expect(out).toContain('<learned-context>');
    expect(out).toContain('running tests');
    expect(out).toContain('use bun test');
    expect(out).toContain('</learned-context>');
  });
});
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement** (mirror `src/memory/injection.ts` `formatMemorySnapshot`):

```typescript
// src/learning-layer/recall/format.ts
// Render selected lessons into a fenced snapshot for injection ahead of a turn.
import type { RecalledLesson } from '../ports.js';

const PREAMBLE =
  'The following is recalled learned context (instincts from prior sessions), NOT new user input. Apply it where relevant.';

export function formatRecallSnapshot(lessons: readonly RecalledLesson[]): string {
  if (lessons.length === 0) return '';
  const lines = lessons.map((l) => `- when ${l.trigger} → ${l.action}`);
  return `${PREAMBLE}\n<learned-context>\n${lines.join('\n')}\n</learned-context>`;
}
```

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(learning-layer): Recall snapshot formatter"`.

### T8 — Assemble the layer (`createLearningLayer`) (~20 min · Opus)

**Files:**
- Create: `src/learning-layer/index.ts`
- Test: `tests/learning-layer/index.test.ts`

- [ ] **Step 1: Write the failing test** (seed a corpus via Persist, assert `recall()` returns matching, formatted lessons).

```typescript
// tests/learning-layer/index.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsPersist } from '../../src/learning-layer/adapters/harness/persistFs.js';
import { serializeInstinct } from '../../src/learning/instinctSerde.js';
import { createLearningLayer } from '../../src/learning-layer/index.js';
import type { Instinct } from '../../src/learning/types.js';

const home = mkdtempSync(join(tmpdir(), 'layer-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('createLearningLayer.recall', () => {
  test('returns a formatted snapshot for a relevant seeded instinct', async () => {
    const persist = createFsPersist(home);
    const inst: Instinct = {
      id: 'tests', trigger: 'running the test suite', action: 'use bun test',
      confidence: 0.6, evidence_count: 10, domain: 'testing', scope: 'project',
      project_id: 'proj', project_name: 'demo',
      created_at: '2026-06-03T00:00:00.000Z', last_evidence_at: '2026-06-03T00:00:00.000Z',
      observation_ids: [],
    };
    await persist.write('learning/proj/instincts/tests.md', serializeInstinct(inst, ''));
    const layer = createLearningLayer({ persist, reason: { complete: async () => '' } });
    const res = await layer.recall({ projectId: 'proj', latestUserText: 'run the test suite', tokenBudget: 1000, maxLessons: 8 });
    expect(res.injectionText).toContain('use bun test');
    expect(res.lessons.map((l) => l.id)).toContain('tests');
  });
  test('recall is fail-open: a broken corpus yields an empty result, not a throw', async () => {
    const persist = createFsPersist(mkdtempSync(join(tmpdir(), 'layer2-')));
    const layer = createLearningLayer({ persist, reason: { complete: async () => '' } });
    const res = await layer.recall({ projectId: 'nope', latestUserText: 'x', tokenBudget: 1000, maxLessons: 8 });
    expect(res).toEqual({ injectionText: '', lessons: [] });
  });
});
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement** — `createLearningLayer(deps)` returns an object implementing `LearningLayer`:
  - `recall(ctx)`: wrap in try/catch (fail-open → `{ injectionText: '', lessons: [] }`); `const instincts = await readInstincts(deps.persist, ctx.projectId)`; `const lessons = assembleLessons({ instincts, latestUserText: ctx.latestUserText, maxLessons: ctx.maxLessons, tokenBudget: ctx.tokenBudget })`; `return { injectionText: formatRecallSnapshot(lessons), lessons }`.
  - `observeSession`/`observeToolEvent`: Phase 1 no-op pass-throughs (the existing capture hooks still write the corpus directly; the Observe API is the seam, wired in T-future). Add a one-line comment citing D1 (Observe wrapping deferred — existing hooks remain authoritative this phase).

> Note: keeping Observe as a documented pass-through in Phase 1 avoids double-writing the corpus. The contract is defined; the rebind is Phase 2 sealing.

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(learning-layer): createLearningLayer wiring Recall over Persist"`.

### T9 — Host-side recall splice + `query()` hook (~25 min · Opus)

**Files:**
- Create: `src/core/recallInjection.ts`
- Modify: `src/core/types.ts`, `src/core/query.ts`
- Test: `tests/core/recallInjection.test.ts`

- [ ] **Step 1: Write the failing test** (mirror the memory-injection tests; assert no mutation).

```typescript
// tests/core/recallInjection.test.ts
import { describe, expect, test } from 'bun:test';
import { injectRecallIntoLatestUserMessage } from '../../src/core/recallInjection.js';
import type { Message } from '../../src/core/types.js';

const userMsg = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] }) as Message;

describe('injectRecallIntoLatestUserMessage', () => {
  test('empty injection text returns history unchanged (same ref)', () => {
    const h = [userMsg('hello')];
    expect(injectRecallIntoLatestUserMessage(h, '')).toBe(h);
  });
  test('prepends snapshot to the latest user message without mutating the input', () => {
    const h = [userMsg('older'), userMsg('run the tests')];
    const out = injectRecallIntoLatestUserMessage(h, 'SNAP');
    expect(JSON.stringify(out[1])).toContain('SNAP');
    expect(JSON.stringify(out[1])).toContain('run the tests');
    expect(JSON.stringify(h[1])).not.toContain('SNAP'); // original untouched
  });
});
```

> Confirm `Message`/`ContentBlock` text-block shape against `src/core/types.js` and mirror `src/memory/injection.ts` exactly (it already solves "prepend to the latest user text block").

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement**
  - `src/core/recallInjection.ts`: `injectRecallIntoLatestUserMessage(history, injectionText)` — if `!injectionText` return `history`; else find the last `role === 'user'` message, return a new array with that message replaced by a copy whose first text block is `injectionText + '\n\n' + originalText` (immutable; mirror memory's helper).
  - `src/core/types.ts`: add near `:112` —
    ```typescript
    import type { RecallResult } from '../learning-layer/ports.js';
    export type RecallTurn = (latestUserText: string | undefined) => Promise<RecallResult>;
    // in QueryParams:
    recall?: RecallTurn;
    ```
  - `src/core/query.ts`: right after the memory injection block (`:72-74`), add:
    ```typescript
    if (params.recall) {
      const recalled = await params.recall(originalUserText);
      history = injectRecallIntoLatestUserMessage(history, recalled.injectionText);
    }
    ```
    (import the helper at the top.)

- [ ] **Step 4: Run green** — `bun test tests/core/recallInjection.test.ts` → PASS; `bun run typecheck` clean.

- [ ] **Step 5: Commit** — `git commit -m "feat(core): wire optional recall splice into the turn loop"`.

### T10 — Runtime + session + server-route wiring + config (~35 min · Opus)

**Files:**
- Modify: `src/config/schema.ts`, `src/server/runtime.ts`, `src/server/sessionContext.ts`, `src/server/routes/turns.ts`, `src/context/budget.ts`
- Test: `tests/config/schema.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (config shape first).

```typescript
// tests/config/schema.test.ts — extend
import { describe, expect, test } from 'bun:test';
import { SettingsSchema } from '../../src/config/schema.js';

describe('learning.recall schema', () => {
  test('defaults: recall disabled with sane budgets', () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.learning?.recall?.enabled ?? false).toBe(false);
  });
  test('accepts a recall override', () => {
    const parsed = SettingsSchema.parse({ learning: { recall: { enabled: true, maxLessons: 5, tokenBudget: 800 } } });
    expect(parsed.learning?.recall?.enabled).toBe(true);
    expect(parsed.learning?.recall?.maxLessons).toBe(5);
  });
});
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement**
  - `src/config/schema.ts` (in the `learning` object ~:318): add
    ```typescript
    recall: z.object({
      enabled: z.boolean().default(false),
      maxLessons: z.number().int().positive().default(8),
      tokenBudget: z.number().int().positive().default(1200),
    }).optional(),
    evidenceSaturation: z.number().positive().optional(),
    synthesizeOnSessionEndAfter: z.number().int().positive().optional(),
    ```
  - `src/context/budget.ts`: add `'instinct'` to the `ComponentKind` union.
  - `src/server/runtime.ts`: at boot, construct
    ```typescript
    const learningLayer = createLearningLayer({
      persist: createFsPersist(harnessHome),
      reason: createProviderReason(resolvedProvider.transport, model),
    });
    ```
    and stash `runtime.learningLayer = learningLayer` (add the field to the `Runtime` type).
  - `src/server/sessionContext.ts`: near the `memoryManager` build (`:253`), add a per-session thunk and expose it on the session-context type/object:
    ```typescript
    const recallCfg = userSettings.learning?.recall;
    const recall: RecallTurn | undefined = recallCfg?.enabled
      ? (latestUserText) => runtime.learningLayer.recall({
          projectId: projectScope.projectId,
          latestUserText,
          tokenBudget: recallCfg.tokenBudget ?? 1200,
          maxLessons: recallCfg.maxLessons ?? 8,
        })
      : undefined;
    // expose alongside memoryManager (type field + object literal ~:267)
    ```
    (Confirm `projectScope`'s project-id field name in this file.)
  - `src/server/routes/turns.ts` (`:557-591` `query({...})`): add **both**
    ```typescript
    memoryManager: sessionCtx.memoryManager,
    recall: sessionCtx.recall,
    ```

- [ ] **Step 4: Run green** — `bun test tests/config/schema.test.ts` → PASS; `bun run typecheck && bun run lint` clean; `bun run test` shows no new failures.

- [ ] **Step 5: Commit** — `git commit -m "feat(server): construct the learning layer + thread recall and memory into the turns route"`.

### T11 — Deterministic loop wiring proof (MockProvider) + memory-fix test (~30 min · Opus)

> D14: prove, without LLM variance, that (a) with a seeded corpus + recall on, the recall snapshot reaches the provider request and changes the scripted tool calls vs recall off; (b) the server route now injects memory.

**Files:**
- Test: `tests/server/turns.recall.test.ts`

- [ ] **Step 1: Write the failing test** — drive a turn through the server route (or `query()` directly with a MockProvider `toolUseScript`) twice: recall-off and recall-on with a seeded instinct (e.g. trigger "run tests" → action "use bun test"). Script the MockProvider so its first request is inspected: assert the recall-on request's `messages` contain `<learned-context>` and `use bun test`, and the recall-off request does not. Add a second test asserting that when `memoryManager` is present on the route, the request contains the `<memory-context>` block (the D6 fix).

```typescript
// tests/server/turns.recall.test.ts (shape)
import { describe, expect, test } from 'bun:test';
// build a runtime with MockProvider, learning.recall.enabled true/false,
// seed an instinct into the sandbox harnessHome via serializeInstinct + createFsPersist,
// capture the first provider request (MockProvider records lastRequest),
// assert injection presence/absence.
```

> Reuse the harness-construction helpers used by existing `tests/server/turns.*.test.ts` (e.g. `tests/helpers/`); follow `turns.learning.test.ts` for the runtime+MockProvider setup pattern.

- [ ] **Step 2: Run red** → FAIL (recall not yet observable / asserts fail before wiring is exercised end-to-end).

- [ ] **Step 3: Implement** — make the test pass by correcting any wiring gaps surfaced (this task is mostly test, but fix the route/sessionContext threading if the assertions reveal a miss). If MockProvider doesn't already record its last request, add a minimal `lastRequest` static capture.

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "test(server): deterministic proof recall + memory inject through the turns route"`.

### T12 — Confidence curve fix (~20 min · Opus)

**Files:**
- Modify: `src/learning/confidence.ts`, `src/tools/InstinctProposeTool.ts`, `src/tools/InstinctUpdateConfidenceTool.ts`
- Test: `tests/learning/confidence.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning/confidence.test.ts — extend
import { describe, expect, test } from 'bun:test';
import { confidenceFromEvidence } from '../../src/learning/confidence.js';

describe('confidenceFromEvidence', () => {
  test('zero evidence → 0', () => expect(confidenceFromEvidence(0)).toBe(0));
  test('~6 obs clears the 0.3 prune floor', () => expect(confidenceFromEvidence(6)).toBeGreaterThanOrEqual(0.3));
  test('~20 obs clears the 0.7 promotion gate', () => expect(confidenceFromEvidence(20)).toBeGreaterThanOrEqual(0.7));
  test('monotonic increasing', () => expect(confidenceFromEvidence(10)).toBeGreaterThan(confidenceFromEvidence(5)));
  test('never reaches the cap', () => expect(confidenceFromEvidence(100000)).toBeLessThan(0.9));
});
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement** — add to `src/learning/confidence.ts`:

```typescript
const DEFAULT_EVIDENCE_SATURATION = 13; // obs count scale; ~6 clears 0.3, ~20 clears 0.7 at cap 0.9

/** Absolute confidence as a saturating function of TOTAL supporting evidence.
 *  Replaces the near-flat logarithmic accumulation for propose/update. */
export function confidenceFromEvidence(totalEvidenceCount: number, tuning?: ConfidenceTuning): number {
  if (totalEvidenceCount <= 0) return 0;
  const cap = tuning?.confidenceCap ?? DEFAULT_CONFIDENCE_CAP;
  const tau = tuning?.evidenceSaturation ?? DEFAULT_EVIDENCE_SATURATION;
  return roundTo(cap * (1 - Math.exp(-totalEvidenceCount / tau)), 3);
}
```
  Add `evidenceSaturation?: number` to `ConfidenceTuning`. Then: in `InstinctProposeTool.ts` replace `reinforce(0, evidence_count)` with `confidenceFromEvidence(evidence_count, tuning)`; in `InstinctUpdateConfidenceTool.ts` recompute `confidence = confidenceFromEvidence(updatedEvidenceCount, tuning)` (pass the tuning already loaded from `tuning.ts`). Read `evidenceSaturation` through the existing tuning plumbing.

- [ ] **Step 4: Run green** → PASS (and existing confidence tests still pass).

- [ ] **Step 5: Commit** — `git commit -m "fix(learning): saturating confidence curve so real evidence reaches usable confidence"`.

### T13 — Cluster normalization (~20 min · Opus)

**Files:**
- Modify: `src/learning/cluster.ts`
- Test: `tests/learning/cluster.test.ts` (extend or create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning/cluster.test.ts
import { describe, expect, test } from 'bun:test';
import { clusterKey, clusterObservations, normalizeActionPattern } from '../../src/learning/cluster.js';
import type { Observation } from '../../src/learning/types.js';

const obs = (summary: string): Observation => ({
  tool_name: 'Bash', tool_input_hash: 'h', tool_input_summary: summary, status: 'success',
  duration_ms: 1, trace_id: 't',
}) as Observation;

describe('cluster normalization', () => {
  test('paths/numbers/quoted strings collapse to placeholders', () => {
    expect(normalizeActionPattern('ls -la /Users/a/Desktop')).toBe(normalizeActionPattern('ls -la /Users/b/code'));
  });
  test('same command over different paths forms ONE cluster', () => {
    const observations = ['~/a', '~/b', '~/c', '~/d'].map((d) => obs(`ls -la ${d}`));
    const clusters = clusterObservations(observations);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].observations).toHaveLength(4);
  });
  test('different tool names stay distinct', () => {
    const a = obs('cat x'); const b = { ...obs('cat x'), tool_name: 'Grep' } as Observation;
    expect(clusterKey(a)).not.toBe(clusterKey(b));
  });
});
```

> Match `obs()` to the real `Observation` schema in `src/learning/types.ts`.

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement** in `src/learning/cluster.ts`:

```typescript
export function normalizeActionPattern(summary: string): string {
  return summary
    .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '<str>') // quoted strings
    .replace(/[~.]?\/[^\s'"]+/g, '<path>')          // paths (abs, rel, ~/)
    .replace(/\b\d[\d.,:_-]*\b/g, '<n>')            // numbers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ACTION_PATTERN_MAX);
}

export function clusterKey(obs: Observation): string {
  return `${obs.tool_name}::${normalizeActionPattern(obs.tool_input_summary)}::${obs.status}`;
}
```

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "fix(learning): normalize cluster key so same-tool/different-arg observations co-cluster"`.

### T14 — Synthesis cadence + bias + visibility (~25 min · Opus)

**Files:**
- Modify: `src/review/manager.ts`, `src/learning/synthesizer.ts`, `bundle-default/agents/instinct-synthesizer.md`
- Test: `tests/review/manager.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — assert an end-of-session hook on `ReviewManager` dispatches the synthesizer when ≥ `synthesizeOnSessionEndAfter` (default 10) new observations have accrued since the last run, and does **not** when below threshold. Use the manager's existing fake-clock / injected-dispatch test pattern (see existing `manager.test.ts`).

```typescript
// tests/review/manager.test.ts — extend (shape)
// construct ReviewManager with a spy dispatch, simulate N observations + onSessionEnd(),
// expect synthesizer dispatched when N >= threshold, not when N < threshold.
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement**
  - `src/review/manager.ts`: add an `onSessionEnd()` path (or extend the existing end hook) that dispatches the synthesizer when `newObservationsSinceLastSynthesis >= (thresholds.synthesizeOnSessionEndAfter ?? 10)`; track the counter on the manager. Honor `minIntervalMs`.
  - `src/learning/synthesizer.ts`: stop swallowing — on a non-`completed` terminal or thrown error, record an assertable status (e.g. return/log `{ ok: false, reason }`) instead of silent `catch {}`. Keep it non-blocking to the user turn.
  - `bundle-default/agents/instinct-synthesizer.md`: replace "Producing zero proposals is a valid outcome / preferred" framing with "Propose an instinct for any pattern with ≥3 consistent observations; be precise about trigger and action. Do not invent patterns." Raise `maxTurns` (8 → 16).

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "fix(learning): end-of-session synthesis trigger, fail-loud, less zero-bias"`.

### T15 — Eval scorer (`score.ts`) (~20 min · Opus)

**Files:**
- Create: `src/learning-layer/eval/score.ts`
- Test: `tests/learning-layer/eval.score.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/learning-layer/eval.score.test.ts
import { describe, expect, test } from 'bun:test';
import { scoreScenario, type ArmResult } from '../../src/learning-layer/eval/score.js';

const arm = (passed: boolean, toolCalls: number): ArmResult => ({ passed, toolCalls });

describe('scoreScenario', () => {
  test('correctness flip = without fails AND with passes', () => {
    const r = scoreScenario({ scenario: 's', without: arm(false, 9), with: arm(true, 4) });
    expect(r.flip).toBe(true);
    expect(r.regression).toBe(false);
  });
  test('regression = with does worse (passed→failed)', () => {
    const r = scoreScenario({ scenario: 's', without: arm(true, 5), with: arm(false, 5) });
    expect(r.flip).toBe(false);
    expect(r.regression).toBe(true);
  });
  test('both pass → efficiency delta reported, no flip', () => {
    const r = scoreScenario({ scenario: 's', without: arm(true, 8), with: arm(true, 5) });
    expect(r.flip).toBe(false);
    expect(r.efficiencyDelta).toBe(3);
  });
});
```

- [ ] **Step 2: Run red** → FAIL.

- [ ] **Step 3: Implement** — pure `scoreScenario({scenario, without, with})` → `{ scenario, flip: !without.passed && withArm.passed, regression: without.passed && !withArm.passed, efficiencyDelta: without.toolCalls - withArm.toolCalls }`. Add a `verdict(results, { minFlips, repetitions })` helper returning PASS/FAIL per D11 (≥`minFlips` flips, zero regressions). Export `ArmResult`/`ScenarioScore` types.

- [ ] **Step 4: Run green** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(learning-layer): eval scorer (correctness flip + efficiency)"`.

### T16 — Eval runner + scenario format + `eval:learning` script (~30 min · Opus)

**Files:**
- Create: `src/learning-layer/eval/runner.ts`, `src/learning-layer/eval/scenarios/index.ts`
- Modify: `package.json`
- Test: covered by T17's deterministic case + a smoke run

- [ ] **Step 1: Define the scenario type + a placeholder export (compile target)** in `scenarios/index.ts`:

```typescript
// src/learning-layer/eval/scenarios/index.ts
import type { Instinct } from '../../../learning/types.js';

export interface LearningScenario {
  readonly name: string;
  /** Files written into the sandbox cwd before the run. */
  readonly sandbox: Readonly<Record<string, string>>;
  /** Instincts seeded into the corpus (Track A). Empty for Track B (real synthesis). */
  readonly seedInstincts: readonly { instinct: Instinct; body: string }[];
  /** The dependent task run in session N+1. */
  readonly task: string;
  /** Judge criteria deciding pass/fail of the task. */
  readonly mustSatisfy: readonly string[];
  readonly shouldNot?: readonly string[];
  readonly track: 'A' | 'B';
}

export const scenarios: LearningScenario[] = []; // populated in T17/T18
```

- [ ] **Step 2: Implement the runner** `src/learning-layer/eval/runner.ts`:
  - For each scenario, build a sandbox + a `home` dir; seed instincts via `createFsPersist(home)` + `serializeInstinct`; write `userConfig` forcing `learning.recall.enabled` (per arm), `review.autoPromoteMemory/Skills: true` (D12).
  - Run both arms via the semantic driver `runHarnessSession` (`tests/semantic/framework/driver.ts`) — recall **off** then **on** — capturing the transcript + tool-call count.
  - Judge each arm against `mustSatisfy`/`shouldNot` using the framework's judge (`framework/judges/index.ts`); produce `ArmResult`.
  - Score via `scoreScenario`; aggregate via `verdict`; print a per-scenario table + PASS/FAIL.

- [ ] **Step 3: Add the script** to `package.json`: `"eval:learning": "bun run src/learning-layer/eval/runner.ts"`.

- [ ] **Step 4: Typecheck/lint green** — `bun run typecheck && bun run lint`. (No scenarios yet → runner is a no-op verdict; that's fine.)

- [ ] **Step 5: Commit** — `git commit -m "feat(learning-layer): with-vs-without eval runner + scenario format"`.

### T17 — Track-A curated scenarios + semantic suite (~40 min · Opus)

**Files:**
- Modify: `src/learning-layer/eval/scenarios/index.ts` (add ≥5 Track-A scenarios)
- Create: `tests/semantic/suites/24-learning-recall.cases.ts`

- [ ] **Step 1: Author ≥5 curated scenarios** per the spec's categories. **Each lesson must be load-bearing and non-derivable from ambient context** (otherwise the baseline passes too and there is no flip). Example (tool/command choice):

```typescript
{
  name: 'unusual-test-command',
  sandbox: {
    // a repo where the test command is non-obvious: package.json has NO "test" script,
    // and a Makefile target `check` runs the suite. Nothing states this in CLAUDE.md.
    'Makefile': 'check:\n\t@echo "ran 12 tests, all pass"\n',
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2),
  },
  seedInstincts: [{
    instinct: { id: 'testcmd', trigger: 'run the test suite in this repo',
      action: 'run `make check` (there is no npm/bun test script here)',
      confidence: 0.7, evidence_count: 20, domain: 'testing', scope: 'project',
      project_id: 'eval', project_name: 'demo',
      created_at: '2026-06-03T00:00:00.000Z', last_evidence_at: '2026-06-03T00:00:00.000Z',
      observation_ids: [] },
    body: '',
  }],
  task: 'Run this project\'s test suite and tell me the result.',
  mustSatisfy: ['Ran `make check` (not npm/bun/jest)', 'Reported the suite passed'],
  shouldNot: ['Claimed there is no way to run tests', 'Tried npm test / bun test as the final answer'],
  track: 'A',
}
```
  Add four more across: repo-convention (change X and Y together), known-pitfall (do Z not X), workflow-ordering (lint before commit), and a spare. Keep each self-contained and unambiguous for a judge.

- [ ] **Step 2: Mirror them as semantic cases** in `tests/semantic/suites/24-learning-recall.cases.ts` (`export const tests: SemanticTest[]`), each using `setup.userConfig` (recall on + autoPromote on), `setup.home` seeding the instinct, and `judgeCriteria.mustSatisfy/shouldNot`. These give a CI-visible recall-behavior signal alongside the standalone eval.

- [ ] **Step 3: Run the eval** — `bun run eval:learning`. Expected: ≥3 of 5 scenarios flip (baseline fails, with-learning succeeds), zero regressions → **Q1 PASS**. Record the table.

> If fewer than 3 flip: triage per scenario (was the lesson derivable? did recall inject? did the judge mis-score?). Fixing scenarios/criteria is expected iteration — the *wiring* is already proven deterministically in T11.

- [ ] **Step 4: Commit** — `git commit -m "feat(learning-layer): Track-A curated recall scenarios + semantic suite (Q1 eval)"`.

### T18 — Track-B real-synthesis scenario (~30 min · Opus)

**Files:**
- Modify: `src/learning-layer/eval/scenarios/index.ts` (add 1–2 Track-B scenarios)

- [ ] **Step 1: Author a full-loop scenario** (`track: 'B'`, empty `seedInstincts`): session N performs a task that generates ≥`synthesizeOnSessionEndAfter` consistent observations of a learnable pattern; the runner triggers real synthesis (the fixed pipeline) at session end; session N+1 runs the dependent task with recall on.

- [ ] **Step 2: Extend the runner** to support Track B: run session N (recall off, real tools), invoke synthesis (`runSynthesizer` via the same scheduler path the manager uses, or trigger the manager's end-of-session hook), confirm an instinct was written to the corpus, then run session N+1 (recall on) and score.

- [ ] **Step 3: Run** — `bun run eval:learning`. Expected: the Track-B scenario produces a real instinct and the N+1 arm flips. This is the end-to-end Observe→Reason→Persist→Recall proof.

> If synthesis still yields nothing on a deliberately-repetitive session N, the yield fix (T12–T14) needs another pass — capture the gap in the close-out (this is exactly the kind of negative finding the spike is meant to surface).

- [ ] **Step 4: Commit** — `git commit -m "feat(learning-layer): Track-B end-to-end synthesis→recall eval scenario"`.

### T19 — Close-out: docs, release, state, cross-repo flag (~30 min · Opus; version bump Sonnet-eligible)

**Files:**
- Modify: `docs/03-cli-reference/usage.md`, `docs/06-testing/testing-log.md`, `package.json` (version), `CLAUDE.md` + `AGENTS.md`
- Create: `docs/07-history/state/2026-06-03-learning-loop-spike-phase-1.md`

- [ ] **Step 1: `docs/03-cli-reference/usage.md`** — add a "Learning recall" subsection: what `learning.recall.{enabled,maxLessons,tokenBudget}` does, that it's off by default, and how to run `bun run eval:learning`.

- [ ] **Step 2: State snapshot** — write `docs/07-history/state/2026-06-03-learning-loop-spike-phase-1.md`: what shipped (ports + adapter #1 + closed Recall + server-route fix + yield fix + eval), the **Q1 verdict** (PASS/FAIL with the eval table), the deferred Phase-2 items, the suite counts, and the founder-reserved decisions still open.

- [ ] **Step 3: Testing-log** — append a Phase 1 entry to `docs/06-testing/testing-log.md` (newest-first) per the testing-log convention: commands run, results, the eval verdict.

- [ ] **Step 4: State pointer** — update the `docs/07-history/state/...` pointer in `CLAUDE.md` **and** `AGENTS.md` (byte-identical; `diff CLAUDE.md AGENTS.md` empty).

- [ ] **Step 5: Release** — bump `package.json` version (next patch), run the gate, `sov upgrade`, and cut the binary release per `docs/05-conventions/cutting-releases.md` (runtime changed, so this is required).

- [ ] **Step 6: Cross-repo flag** — per the kickoff "Keeping the record straight," update **or flag for a docs-repo session**: the spike spec's Phase-1 `**Status:**`, the `learning-loop-closure-and-proof` open-question, and the dev status page in `sovereign-ai-docs`. (This repo can't commit there; leave a clear note in the state snapshot.)

- [ ] **Step 7: Commit + push** — `git commit -m "chore(release): learning-loop spike Phase 1 close-out + vX.Y.Z"` and push.

---

## Self-review

**Spec coverage** (every spec section → a task):
- Four-port contract (ports) → T1. Adapter bindings → Persist T2, Reason T3, Recall T8–T10, Observe pass-through T8. Closing Recall (assemble/format/inject/budget) → T6, T7, T9, T10. Server-route fix (D6) → T10 + proven T11. Persist-reader+serde (D7 refined) → T4, T5. Synthesis yield fix (D9 a/b/c) → T12, T13, T14. Eval Track A (D10/D11/D12) → T15, T16, T17. Eval Track B → T18. Determinism (D14) → T11. Config (D13) → T10. Close-out + cross-repo → T19. **No uncovered section.**
- Founder-reserved items (engine choice, go/no-go, auto-promote default, recall-on default) are correctly **not** implemented — only surfaced in T19's snapshot.

**Placeholder scan:** no "TBD/TODO/handle edge cases"; pure-logic tasks (T1, T2, T6, T7, T12, T13, T15) carry complete code; wiring tasks carry the key diff + verified anchors + real tests. The few "confirm field name in the file" notes are deliberate last-mile reads for the Opus executor, not missing logic.

**Type consistency:** `RecallResult`/`RecalledLesson`/`RecallContext`/`PersistPort`/`ReasonPort`/`LearningHostDeps` (T1) are used consistently in T2/T3/T5/T6/T7/T8; `RecallTurn` (T9 `types.ts`) matches the thunk built in T10 (`sessionContext`) and consumed in T9 (`query.ts`) + T10 (`turns.ts`); `confidenceFromEvidence` (T12) signature matches its callers; `assembleLessons`/`formatRecallSnapshot`/`readInstincts`/`scoreScenario` signatures are stable across the tasks that call them.

**One risk to watch during execution:** T11 may surface that MockProvider needs a `lastRequest` capture — that's an allowed in-task addition (noted in T11 Step 3). T17/T18 flips depend on real-LLM behavior; the deterministic wiring proof (T11) de-risks the loop independent of that variance, so a soft eval result is a *findings* outcome, not a blocked plan.

---

## Execution handoff

Plan complete and saved to `plans/2026-06-03-learning-loop-spike-phase-1.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks, fast iteration. (`superpowers:subagent-driven-development`.)
2. **Inline Execution** — execute tasks in this session with batch checkpoints. (`superpowers:executing-plans`.)
