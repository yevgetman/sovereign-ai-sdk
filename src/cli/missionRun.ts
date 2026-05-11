// Non-interactive scheduled-mission wake. Invoked by `sov mission run
// --state-dir <dir>` (and indirectly by launchd jobs). Performs exactly
// one wake: acquires the .lock/ overlap guard, loads state, runs a
// single agent turn against the scheduled-mission agent, parses the
// transition sentinel and notes-update block from the model's reply,
// writes the new state atomically, releases the lock. Headless — no
// TTY, no readline, no Ink.

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAgents } from '../agents/loader.js';
import { getDefaultBundlePath } from '../bundle/defaultBundle.js';
import { loadBundleIfPresent } from '../bundle/loader.js';
import { buildToolScope } from '../commands/toolScope.js';
import { resolveHarnessHome } from '../config/paths.js';
import { readConfig } from '../config/store.js';
import { query } from '../core/query.js';
import { buildSystemSegments } from '../core/systemPrompt.js';
import type { ContentBlock, Message, SystemSegment, Terminal } from '../core/types.js';
import { createDefaultMemoryManager } from '../memory/provider.js';
import { resolveProjectScope } from '../memory/scope.js';
import { applyTransition, shouldRun } from '../mission/fsm.js';
import { missionMdPath, notesMdPath, stateJsonPath } from '../mission/paths.js';
import { buildMissionSegments } from '../mission/segments.js';
import {
  acquireLock,
  appendWakeLog,
  loadMissionState,
  releaseLock,
  writeMissionState,
} from '../mission/state.js';
import { resolveProvider } from '../providers/resolver.js';
import { assembleToolPool } from '../tool/registry.js';
import type { Tool, ToolContext } from '../tool/types.js';

const MISSION_AGENT_NAME = 'scheduled-mission';
const DEFAULT_MAX_TOKENS = 4096;

export type MissionWakeOpts = {
  readonly stateDir: string;
  /** Optional bundle override. Defaults to the same lookup `terminalRepl`
   *  uses today (`getDefaultBundlePath()`). Passing an explicit path is
   *  primarily useful for tests and out-of-tree client bundles. */
  readonly bundlePath?: string;
  /** Optional agent name override. Defaults to `scheduled-mission`.
   *  Mission-mode agents must declare `supportsMissionState: true` in
   *  their frontmatter or the wake aborts. */
  readonly agentName?: string;
  /** Optional max-tokens override. Defaults to 4096. */
  readonly maxTokens?: number;
};

export type MissionWakeResult = {
  /** True when the runner returned without invoking the model (terminal
   *  FSM state, missing files, agent misconfiguration). `reason` carries
   *  the explanation. */
  readonly exitedEarly?: boolean;
  /** True when the `.lock/` directory was already present at start time
   *  — another wake is in flight; skip this invocation. */
  readonly lockHeld?: boolean;
  /** Human-readable explanation paired with `exitedEarly` / `lockHeld`. */
  readonly reason?: string;
  /** When a wake completed: the FSM state at the end of the turn. */
  readonly transitionedTo?: string;
};

export async function runMissionWake(opts: MissionWakeOpts): Promise<MissionWakeResult> {
  const stateDir = resolve(opts.stateDir);
  if (!existsSync(missionMdPath(stateDir))) {
    return { exitedEarly: true, reason: `mission.md not found in ${stateDir}` };
  }
  if (!existsSync(stateJsonPath(stateDir))) {
    return { exitedEarly: true, reason: `state.json not found in ${stateDir}` };
  }

  // Overlap-guard: a pre-existing `.lock/` means another wake is in
  // flight. Return without touching the lock so the actual holder can
  // release it cleanly when it finishes.
  if (!acquireLock(stateDir)) {
    return { lockHeld: true, reason: 'lock held' };
  }

  try {
    return await runMissionWakeLocked(stateDir, opts);
  } finally {
    releaseLock(stateDir);
  }
}

async function runMissionWakeLocked(
  stateDir: string,
  opts: MissionWakeOpts,
): Promise<MissionWakeResult> {
  const missionFiles = loadMissionState(stateDir);
  if (!shouldRun(missionFiles.state.fsmState)) {
    return {
      exitedEarly: true,
      reason: `mission in terminal state "${missionFiles.state.fsmState}"`,
    };
  }

  const wakeStartedAt = Date.now();
  const bundlePath = opts.bundlePath ?? getDefaultBundlePath();
  const bundle = await loadBundleIfPresent(bundlePath);
  const harnessHome = resolveHarnessHome();

  const agentName = opts.agentName ?? MISSION_AGENT_NAME;
  const loadedAgents = await loadAgents({
    harnessHome,
    cwd: process.cwd(),
    ...(bundle ? { bundleRoot: bundle.root } : {}),
  });
  const agentDef = loadedAgents.byName.get(agentName);
  if (agentDef === undefined) {
    return { exitedEarly: true, reason: `agent "${agentName}" not found` };
  }
  if (!agentDef.supportsMissionState) {
    return {
      exitedEarly: true,
      reason: `agent "${agentName}" does not declare supportsMissionState: true`,
    };
  }

  const userSettings = readConfig();
  const projectScope = resolveProjectScope({
    cwd: process.cwd(),
    bundle: bundle ?? null,
    harnessHome,
  });
  const memoryManager = createDefaultMemoryManager(harnessHome, projectScope);
  await memoryManager.initialize();
  await memoryManager.onSessionStart();

  try {
    const resolved = resolveProvider(undefined, undefined);
    const cacheEnabled = true;

    // Pre-canUseTool tool listing — drives the system prompt's <available-tools>
    // block and the agent's restricted pool. Mirrors terminalRepl: assemble
    // the full pool, then scope it to the agent's allowedTools.
    const preliminaryToolContext: ToolContext = {
      cwd: process.cwd(),
      ...(bundle ? { bundleRoot: bundle.root } : {}),
      sessionId: 'mission-wake',
      harnessHome,
      memoryManager,
      agents: loadedAgents,
      projectScope,
    };
    const fullPool = assembleToolPool(preliminaryToolContext);
    const scoped = buildToolScope({
      allowedTools: agentDef.allowedTools,
      tools: fullPool,
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    const toolPool: Tool<unknown, unknown>[] = scoped.tools;

    // System prompt: agent prompt → mission segments → standard base
    // segments. Matches the agent-driven branch of openOrResumeSession()
    // in terminalRepl so the model sees an identical prompt shape.
    const baseSegments = buildSystemSegments({
      ...(bundle ? { bundle } : {}),
      tools: toolPool,
      skills: [],
      cwd: process.cwd(),
      cacheEnabled,
      projectScope,
    });
    const systemPrompt: SystemSegment[] = [
      { text: agentDef.systemPrompt, cacheable: cacheEnabled },
      ...buildMissionSegments(missionFiles, { cacheEnabled }),
      ...baseSegments,
    ];

    const wakeNumber = missionFiles.state.wakeCount + 1;
    const wakeMessage = `Wake #${wakeNumber}: please continue working on your mission. Read your mission goal, plan, and notes from the system prompt, then do one bounded piece of work.`;
    const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: wakeMessage }] }];

    const turnMessages: Message[] = [];
    let terminal: Terminal | undefined;
    const gen = query({
      provider: resolved.transport,
      model: resolved.model,
      messages: history,
      systemPrompt,
      ...(toolPool.length > 0
        ? {
            tools: toolPool,
            toolContext: preliminaryToolContext,
            canUseTool: scoped.canUseTool,
          }
        : {}),
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(userSettings.maxTurns !== undefined ? { maxTurns: userSettings.maxTurns } : {}),
      cacheEnabled,
      memoryManager,
      sessionId: 'mission-wake',
      cwd: process.cwd(),
    });

    for (;;) {
      const step = await gen.next();
      if (step.done) {
        terminal = step.value;
        break;
      }
      const ev = step.value;
      if (!ev || typeof ev !== 'object') continue;
      if ('role' in ev) {
        // tool_result carrier message between turns — accumulate into history
        // so the next iteration's provider call sees the full conversation.
        turnMessages.push(ev);
        continue;
      }
      if (!('type' in ev)) continue;
      if (ev.type === 'assistant_message') {
        turnMessages.push(ev.message);
      }
    }

    // Pull the last assistant text from this turn. `MISSION_TRANSITION=...`
    // and the optional `<mission-notes-update>` block live in the agent's
    // final natural-language response, not in any tool result.
    const lastAssistant = [...turnMessages].reverse().find((m) => m.role === 'assistant');
    const lastAssistantText =
      lastAssistant?.role === 'assistant'
        ? lastAssistant.content
            .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : '';

    const sentinelMatch = lastAssistantText.match(/MISSION_TRANSITION=(\w+)/);
    const sentinelValue = sentinelMatch?.[1];
    const notesMatch = lastAssistantText.match(
      /<mission-notes-update>([\s\S]*?)<\/mission-notes-update>/,
    );
    if (notesMatch?.[1] !== undefined) {
      writeFileSync(notesMdPath(stateDir), notesMatch[1].trim(), 'utf8');
    }

    const stateBefore = missionFiles.state.fsmState;
    const stateAfter = applyTransition(stateBefore, sentinelValue);
    writeMissionState(stateDir, {
      fsmState: stateAfter,
      wakeCount: wakeNumber,
      updatedAt: new Date().toISOString(),
    });
    appendWakeLog(stateDir, {
      wakeNumber,
      timestamp: new Date().toISOString(),
      fsmStateBefore: stateBefore,
      fsmStateAfter: stateAfter,
      ...(sentinelValue !== undefined ? { sentinel: sentinelValue } : {}),
      durationMs: Date.now() - wakeStartedAt,
    });

    const reason = terminal?.reason;
    return {
      transitionedTo: stateAfter,
      ...(reason !== undefined ? { reason: `wake completed (${reason})` } : {}),
    };
  } finally {
    await memoryManager.onSessionEnd('mission-wake-complete');
    await memoryManager.shutdown();
  }
}
