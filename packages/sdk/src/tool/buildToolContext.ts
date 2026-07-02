// Task 5.1 — the OPEN tool-context assembler.
//
// `buildToolContext(input)` is the PURE assembly half of the former
// server-bound `buildSessionToolContext`: given already-resolved inputs +
// injected ports, it constructs the per-turn `ToolContext`. It imports nothing
// proprietary — every input is an OPEN type or an OPEN port (the Phase-1 ports
// in `tool/ports.ts`), so the boundary lint keeps it open-clean and the SDK
// barrel can re-export it (§5.1).
//
// The PROPRIETARY half — resolving these inputs off the Runtime god-object +
// per-session `getSessionContext` (learning / review / memory state) — stays in
// `server/routes/turns.ts` (`buildSessionToolContext`), which now resolves the
// inputs and delegates here. The split is behavior-preserving: the assembled
// `ToolContext` is field-for-field identical to the pre-split version for every
// caller (gateway turns, openai, cron, channels, workflows).
//
// Skill visibility (`activeToolNames` / `activeToolsets` / filtered `skills`)
// is derived HERE from the EFFECTIVE pool — the same pool the turn's `query()`
// runs against and that forked sub-agents inherit — so the visibility surface
// tracks any per-turn pool narrowing (e.g. a `/skill` turn's scoped copy).

import type { AgentRegistry } from '../agents/types.js';
import type { Settings } from '../config/schema.js';
import type { SubdirectoryHintState } from '../context/subdirectoryHints.js';
import type { MemoryRuntime } from '../memory/provider.js';
import type { ProjectScope } from '../memory/scope.js';
import type { CanUseTool } from '../permissions/types.js';
import type { SubagentScheduler } from '../runtime/scheduler.js';
import type { SkillRegistry } from '../skills/types.js';
import { filterSkillRegistry, inferActiveToolsets } from '../skills/visibility.js';
import type {
  DelegationLifecycleEvent,
  LaneRegistry,
  LearningObserverPort,
  ReviewManagerPort,
  TaskManagerPort,
} from './ports.js';
import type { Tool, ToolContext } from './types.js';

/** Already-resolved inputs for the pure ToolContext assembly. Every field is an
 *  OPEN type / port; the proprietary per-session resolution (Runtime +
 *  getSessionContext) produces these and hands them to `buildToolContext`.
 *
 *  Optional fields carry `| undefined` so the resolver can pass a possibly-
 *  undefined value directly; the assembler's conditional spreads then keep the
 *  matching `ToolContext` field ABSENT (not `undefined`) — the
 *  exactOptionalPropertyTypes contract the rest of `ToolContext` honors. */
export type BuildToolContextInput = {
  cwd: string;
  sessionId: string;
  harnessHome: string;
  agents: AgentRegistry;
  /** Bundle root when a harness bundle is loaded; absent in generic-agent mode. */
  bundleRoot?: string | undefined;
  subagentScheduler: SubagentScheduler;
  taskManager: TaskManagerPort;
  laneRegistry: LaneRegistry;
  /** The pool THIS turn actually runs against — used BOTH as `parentToolPool`
   *  (forked children inherit it) AND as the source for the active tool-name /
   *  toolset / filtered-skill derivation. */
  effectivePool: Tool<unknown, unknown>[];
  /** The UNFILTERED skill registry; filtered here against the effective pool. */
  skills: SkillRegistry;
  canUseTool: CanUseTool;
  subdirectoryHintState: SubdirectoryHintState;
  memoryManager: MemoryRuntime;
  projectScope: ProjectScope;
  /** WebSearch provider config, resolved from the injected/disk Settings. */
  webSearch?: Settings['webSearch'] | undefined;
  learningObserver?: LearningObserverPort | undefined;
  reviewManager?: ReviewManagerPort | undefined;
  /** Owning principal for the session; absent for the implicit single principal. */
  userId?: string | undefined;
  /** Per-turn delegation lifecycle recorder; absent for callers with no SSE bus. */
  delegationLifecycleRecorder?: ((event: DelegationLifecycleEvent) => void) | undefined;
};

/** Assemble the per-turn `ToolContext` from already-resolved inputs. Pure — no
 *  Runtime, no disk, no per-session lookup. The conditional spreads below mirror
 *  the pre-split assembler exactly, so the returned context is field-for-field
 *  identical for every caller. */
export function buildToolContext(input: BuildToolContextInput): ToolContext {
  // Per-turn skill visibility. The active toolset is derived from the EFFECTIVE
  // pool (the same pool the turn's `query()` runs against), then fed into
  // `inferActiveToolsets` + `filterSkillRegistry` so any skill gated on a tool
  // the turn lacks (or is the fallback half of an active primary/fallback pair)
  // is dropped from the `ToolContext.skills` view the orchestrator sees.
  const activeToolNames = input.effectivePool.map((t) => t.name);
  const activeToolsets = inferActiveToolsets(activeToolNames);
  const filteredSkills = filterSkillRegistry(input.skills, activeToolsets, activeToolNames);
  return {
    cwd: input.cwd,
    sessionId: input.sessionId,
    harnessHome: input.harnessHome,
    agents: input.agents,
    ...(input.bundleRoot !== undefined ? { bundleRoot: input.bundleRoot } : {}),
    subagentScheduler: input.subagentScheduler,
    taskManager: input.taskManager,
    laneRegistry: input.laneRegistry,
    // Forked sub-agents inherit the EFFECTIVE pool, so a child dispatched
    // mid-`/skill`-turn is bounded by the skill's allowedTools.
    parentToolPool: input.effectivePool,
    canUseTool: input.canUseTool,
    skills: filteredSkills,
    activeToolNames,
    activeToolsets,
    ...(input.webSearch !== undefined ? { webSearch: input.webSearch } : {}),
    ...(input.learningObserver !== undefined ? { learningObserver: input.learningObserver } : {}),
    ...(input.reviewManager !== undefined ? { reviewManager: input.reviewManager } : {}),
    subdirectoryHintState: input.subdirectoryHintState,
    memoryManager: input.memoryManager,
    projectScope: input.projectScope,
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.delegationLifecycleRecorder !== undefined
      ? { delegationLifecycleRecorder: input.delegationLifecycleRecorder }
      : {}),
  };
}
