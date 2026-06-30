// Multi-agent workflows — `sov workflow` CLI helpers (W4 / owner C).
//
// Commander handlers in src/main.ts resolve the runtime + harness home and
// call these helpers. They wrap the W3 loader (loadWorkflows) and the W2
// engine (runWorkflow) so the CLI stays a thin shell:
//   - runWorkflowList  — loads every workflow and returns a printable summary.
//   - runWorkflowShow  — resolves one by name and returns its definition.
//   - runWorkflowRun   — builds a runtime (cron-style), mints a `kind:workflow`
//                        parent session, drives the engine, and streams
//                        progress events through `onEvent`. The session is
//                        disposed in a finally so trace/learning writers flush.
//
// Mirrors src/cli/cronCommand.ts (pure helpers + main.ts builds the runtime).

import type { WorkflowEvent } from '../workflows/events.js';
import type { LoadedWorkflow } from '../workflows/types.js';

/** One row in the `sov workflow list` summary. */
export type WorkflowListEntry = {
  name: string;
  description: string;
  source: LoadedWorkflow['source'];
  phaseCount: number;
};

/** Load every workflow from project / user / bundle roots and return a sorted
 *  summary. Pure over the loader; main.ts resolves cwd / harnessHome /
 *  bundleRoot and passes them in so this stays trivially testable. */
export async function runWorkflowList(opts: {
  cwd: string;
  harnessHome: string;
  bundleRoot?: string;
}): Promise<WorkflowListEntry[]> {
  const { loadWorkflows } = await import('../workflows/loader.js');
  const { byName } = await loadWorkflows({
    cwd: opts.cwd,
    harnessHome: opts.harnessHome,
    ...(opts.bundleRoot !== undefined ? { bundleRoot: opts.bundleRoot } : {}),
  });
  return [...byName.values()]
    .map((wf) => ({
      name: wf.def.name,
      description: wf.def.description,
      source: wf.source,
      phaseCount: wf.def.phases.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a single workflow by name. Returns undefined when no workflow with
 *  that name is loaded (main.ts prints "no workflow <name>" + exits 1). */
export async function runWorkflowShow(
  name: string,
  opts: { cwd: string; harnessHome: string; bundleRoot?: string },
): Promise<LoadedWorkflow | undefined> {
  const { loadWorkflows } = await import('../workflows/loader.js');
  const { byName } = await loadWorkflows({
    cwd: opts.cwd,
    harnessHome: opts.harnessHome,
    ...(opts.bundleRoot !== undefined ? { bundleRoot: opts.bundleRoot } : {}),
  });
  return byName.get(name);
}

/** Parse repeated `--arg k=v` tokens into a `{ k: v }` map. Values stay strings
 *  here; the engine coerces against each workflow's declared ArgSpec. A token
 *  with no `=` is an error so a typo never silently drops an argument. */
export function parseArgPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`invalid --arg "${pair}" (expected key=value)`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** Result of a CLI workflow run: the engine's structured result, surfaced so
 *  main.ts can print `finalText` (default) or the full JSON (`--json`). */
export type WorkflowRunOutput = {
  result: import('../workflows/engine.js').WorkflowResult;
};

/** Build a runtime, mint a parent session, and drive the engine for `name`.
 *  Mirrors `sov cron run`: the runtime is built by main.ts and passed in so the
 *  caller owns its lifecycle (dispose). `onEvent` receives every lifecycle
 *  event (main.ts prints formatWorkflowEvent lines). Throws on an unknown
 *  workflow or an engine error so main.ts can exit non-zero. */
export async function runWorkflowRun(args: {
  runtime: import('../server/runtime.js').Runtime;
  name: string;
  args: Record<string, unknown>;
  onEvent?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
}): Promise<WorkflowRunOutput> {
  const { runtime } = args;
  const { loadWorkflows } = await import('../workflows/loader.js');
  const { runWorkflow } = await import('../workflows/engine.js');
  const { buildSessionToolContext } = await import('../server/routes/turns.js');

  const { byName } = await loadWorkflows({
    cwd: runtime.cwd,
    harnessHome: runtime.harnessHome,
    ...(runtime.bundleRoot !== undefined ? { bundleRoot: runtime.bundleRoot } : {}),
  });
  const loaded = byName.get(args.name);
  if (!loaded) {
    const available = [...byName.keys()].sort().join(', ') || '(none loaded)';
    throw new Error(`no workflow named '${args.name}'. Available: ${available}`);
  }

  // Mint a fresh parent session so the run has a stable lineage root for
  // per-task child sessions (the engine passes `parentSessionId` to
  // scheduler.delegate). Tagged `metadata.kind='workflow'` so later cleanup
  // sweeps can scope by tag (mirrors cron's `kind:'cron'`).
  const parentSessionId = runtime.sessionDb.createSession({
    provider: runtime.resolvedProvider.transport.name,
    model: runtime.model,
    title: `workflow:${args.name}`,
    systemPrompt: runtime.systemSegments,
    metadata: { kind: 'workflow', workflow: args.name },
  });

  try {
    const result = await runWorkflow({
      host: {
        cwd: runtime.cwd,
        harnessHome: runtime.harnessHome,
        scheduler: runtime.subagentScheduler,
        buildToolContext: (sid, cut, opts) => buildSessionToolContext(runtime, sid, cut, opts),
      },
      def: loaded.def,
      args: args.args,
      parentSessionId,
      ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    return { result };
  } finally {
    // Reclaim the parent session's in-memory context (trace flush, learning
    // drain). The DB row persists for later inspection (matches cron).
    await runtime.disposeSession(parentSessionId);
  }
}

/** One-line summary for `sov workflow list`. */
export function formatWorkflowLine(entry: WorkflowListEntry): string {
  return `${entry.name.padEnd(24)} ${entry.source.padEnd(8)} ${entry.phaseCount} phase(s)  ${entry.description}`;
}
