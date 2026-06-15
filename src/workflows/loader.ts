// Workflow definition loader (2026-06-15 — multi-agent workflows; see
// docs/specs/2026-06-15-multi-agent-workflows-design.md).
//
// Scans project / user / bundle `workflows/` roots for `*.yaml`, parses +
// validates each against WorkflowDefSchema, and returns a registry keyed by
// workflow name. Project entries beat user entries which beat bundle entries on
// duplicate names (first wins). A parse/validation failure is a loud per-file
// error: the bad file is skipped and the error surfaced via `warn`, never a
// scan crash. The shape and traversal mirror src/agents/loader.ts so future
// changes (hot reload, directory-form workflows) port across.
//
// `validateWorkflow` is the semantic gate the engine runs once the agent
// registry is known: every `task.agent` must resolve to a loaded agent, and
// every `{{...}}` template ref must resolve to a declared arg, the current
// map loop variable, or an EARLIER phase's id.

import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { LoadedWorkflow, Phase, Task, WorkflowDef } from './types.js';
import { WorkflowDefSchema } from './types.js';

const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
const DEFAULT_LOOP_VAR = 'item';
const TEMPLATE_REF_REGEX = /\{\{\s*([^}]+?)\s*\}\}/g;
const ARGS_PREFIX = 'args';

type WorkflowSource = LoadedWorkflow['source'];

type WorkflowRoot = {
  source: WorkflowSource;
  path: string;
};

export type LoadWorkflowsOptions = {
  cwd: string;
  harnessHome: string;
  /** When set, scans the bundle-relative `workflows/` root; absent in
   *  generic-agent mode. */
  bundleRoot?: string;
  warn?: (message: string) => void;
};

export type LoadWorkflowsResult = {
  byName: Map<string, LoadedWorkflow>;
};

/**
 * Load all workflow definitions from project, user, and bundle roots.
 * Precedence project > user > bundle on duplicate names (first wins). A
 * malformed or schema-invalid file is skipped with a `warn`, mirroring the
 * agent loader's per-file tolerance.
 *
 * Async (mirrors src/agents/loader.ts `loadAgents`) — the scan touches the
 * filesystem; callers `await` the result.
 */
export async function loadWorkflows(opts: LoadWorkflowsOptions): Promise<LoadWorkflowsResult> {
  const roots = resolveRoots(opts);
  const seenRealpaths = new Set<string>();
  const byName = new Map<string, LoadedWorkflow>();

  for (const root of roots) {
    for (const file of await listYamlFiles(root.path, opts.warn)) {
      const rp = await safeRealpath(file, opts.warn);
      if (rp === null) continue;
      if (seenRealpaths.has(rp)) continue;
      seenRealpaths.add(rp);

      const loaded = await loadWorkflowFile(file, root, opts.warn);
      if (loaded === null) continue;
      if (byName.has(loaded.def.name)) {
        opts.warn?.(`workflow skipped (${file}): duplicate workflow name '${loaded.def.name}'`);
        continue;
      }
      byName.set(loaded.def.name, loaded);
    }
  }

  return { byName };
}

function resolveRoots(opts: LoadWorkflowsOptions): WorkflowRoot[] {
  const roots: WorkflowRoot[] = [
    { source: 'project', path: join(opts.cwd, '.harness', 'workflows') },
    { source: 'user', path: join(opts.harnessHome, 'workflows') },
  ];
  if (opts.bundleRoot !== undefined) {
    roots.push({ source: 'bundle', path: join(opts.bundleRoot, 'workflows') });
  }
  return roots;
}

async function safeRealpath(
  file: string,
  warn?: (message: string) => void,
): Promise<string | null> {
  try {
    return await realpath(file);
  } catch (err) {
    warn?.(`workflow skipped (${file}): ${errorMessage(err)}`);
    return null;
  }
}

async function loadWorkflowFile(
  path: string,
  root: WorkflowRoot,
  warn?: (message: string) => void,
): Promise<LoadedWorkflow | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = parseYaml(raw);
    const def = WorkflowDefSchema.parse(parsed);
    return { def, source: root.source, path };
  } catch (err) {
    warn?.(`workflow skipped (${path}): ${errorMessage(err)}`);
    return null;
  }
}

async function listYamlFiles(root: string, warn?: (message: string) => void): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  await walk(root, out, warn);
  return out.sort();
}

async function walk(dir: string, out: string[], warn?: (message: string) => void): Promise<void> {
  // Per-DIRECTORY tolerance: an unreadable subdirectory (EACCES, stale mount)
  // is skipped with a warning rather than aborting the whole scan and dropping
  // already-collected workflows (2026-06-15 review fix M5 — mirrors the
  // per-file tolerance in loadWorkflowFile).
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    warn?.(`workflow directory skipped (${dir}): ${errorMessage(err)}`);
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, out, warn);
      continue;
    }
    if (entry.isFile() && YAML_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(path);
    }
  }
}

/**
 * Semantic validation of a loaded workflow against the known agent registry.
 * Returns a list of human-readable error strings (empty ⇒ valid):
 *  - every `task.agent` must name a loaded agent;
 *  - every `task.lane` (if any) must be a known cost-lane name (when
 *    `validLanes` is supplied) — an unknown lane silently mis-routes;
 *  - every `{{...}}` template ref in a prompt must resolve to a declared arg
 *    (`args.<name>`), the current map loop variable, or an EARLIER phase id.
 */
export function validateWorkflow(
  def: WorkflowDef,
  agentNames: Iterable<string>,
  validLanes?: Iterable<string>,
): string[] {
  const errors: string[] = [];
  const agents = new Set(agentNames);
  const lanes = validLanes !== undefined ? new Set(validLanes) : undefined;
  const declaredArgs = new Set(Object.keys(def.args ?? {}));
  const priorPhaseIds = new Set<string>();

  for (const phase of def.phases) {
    const loopVar = phase.map ? (phase.map.as ?? DEFAULT_LOOP_VAR) : null;
    validatePhaseOver(phase, declaredArgs, priorPhaseIds, errors);
    for (const task of phaseTasks(phase)) {
      validateTaskAgent(task, phase.id, agents, errors);
      validateTaskLane(task, phase.id, lanes, errors);
      validateTaskRefs(task, phase.id, declaredArgs, priorPhaseIds, loopVar, errors);
    }
    priorPhaseIds.add(phase.id);
  }

  return errors;
}

function phaseTasks(phase: Phase): Task[] {
  if (phase.tasks !== undefined) return phase.tasks;
  if (phase.task !== undefined) return [phase.task];
  return [];
}

function validatePhaseOver(
  phase: Phase,
  declaredArgs: Set<string>,
  priorPhaseIds: Set<string>,
  errors: string[],
): void {
  if (phase.map === undefined) return;
  const ref = parseRef(phase.map.over);
  if (ref.root === ARGS_PREFIX) {
    if (!ref.field || !declaredArgs.has(ref.field)) {
      errors.push(`phase '${phase.id}' map.over '${phase.map.over}' references unknown arg`);
    }
    return;
  }
  if (!priorPhaseIds.has(ref.root)) {
    errors.push(
      `phase '${phase.id}' map.over '${phase.map.over}' must reference an earlier phase id or args.<arg>`,
    );
  }
}

function validateTaskAgent(
  task: Task,
  phaseId: string,
  agents: Set<string>,
  errors: string[],
): void {
  if (!agents.has(task.agent)) {
    errors.push(`phase '${phaseId}' task references unknown agent '${task.agent}'`);
  }
}

function validateTaskLane(
  task: Task,
  phaseId: string,
  validLanes: Set<string> | undefined,
  errors: string[],
): void {
  if (task.lane === undefined || validLanes === undefined) return;
  if (!validLanes.has(task.lane)) {
    errors.push(
      `phase '${phaseId}' task references unknown lane '${task.lane}' (valid: ${[...validLanes].join(', ')})`,
    );
  }
}

function validateTaskRefs(
  task: Task,
  phaseId: string,
  declaredArgs: Set<string>,
  priorPhaseIds: Set<string>,
  loopVar: string | null,
  errors: string[],
): void {
  for (const expr of extractRefExpressions(task.prompt)) {
    const ref = parseRef(expr);
    const error = resolveRefError(ref, declaredArgs, priorPhaseIds, loopVar);
    if (error !== null) {
      errors.push(`phase '${phaseId}' prompt ref '{{${expr}}}' ${error}`);
    }
  }
}

function resolveRefError(
  ref: ParsedRef,
  declaredArgs: Set<string>,
  priorPhaseIds: Set<string>,
  loopVar: string | null,
): string | null {
  if (loopVar !== null && ref.root === loopVar) return null;
  if (ref.root === ARGS_PREFIX) {
    if (ref.field && declaredArgs.has(ref.field)) return null;
    return `references unknown arg '${ref.field ?? ''}'`;
  }
  if (priorPhaseIds.has(ref.root)) return null;
  return 'references an unknown arg, loop variable, or earlier phase';
}

type ParsedRef = { root: string; field: string | null };

/** Split a dotpath ref into its root token and (optional) first field. */
function parseRef(expr: string): ParsedRef {
  const parts = expr.split('.');
  const root = parts[0] ?? '';
  const field = parts.length > 1 ? (parts[1] ?? null) : null;
  return { root, field };
}

/** Extract the inner expression of every `{{ ... }}` placeholder. */
function extractRefExpressions(prompt: string): string[] {
  const out: string[] = [];
  for (const match of prompt.matchAll(TEMPLATE_REF_REGEX)) {
    const inner = match[1]?.trim();
    if (inner) out.push(inner);
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}
