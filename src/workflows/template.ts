// Safe workflow prompt interpolation (2026-06-15 — multi-agent workflows, see
// docs/specs/2026-06-15-multi-agent-workflows-design.md).
//
// A small, SAFE interpolator: dotpath SUBSTITUTION only. No `eval`, no
// expressions, no function calls — a `{{ref}}` resolves to a value reached by
// walking literal keys, and nothing else. Workflow files are trusted author
// artifacts, but the engine still refuses arbitrary code by construction.
//
// Reference grammar (each `{{...}}` is one of):
//   {{args.X}}                 — a validated workflow arg
//   {{<loopVar>}}              — the current map item (text or whole value)
//   {{<loopVar>.field}}        — a field of the current (parsed-JSON) map item
//   {{<phaseId>.text}}         — a single-task phase's final text
//   {{<phaseId>.json}}         — a single-task phase's parsed JSON value
//   {{<phaseId>.json.field}}   — a field reached inside that parsed JSON
//   {{<phaseId>.results}}      — a map phase's collected outputs (array)
//   {{<phaseId>.<field>}}      — sugar: the flattened array of item.<field>
//                                 across a map phase's JSON outputs
//
// An unresolved reference (unknown root, missing field, wrong phase shape) is a
// clear runtime error — the engine never silently substitutes empty string.

/** A single task's resolved output. `text` is always present (the agent's
 *  final text, or an error marker). `json` is set only for `output: 'json'`
 *  tasks that parsed successfully. `error` records a failed/parse-error task. */
export type TaskOutput = {
  text: string;
  json?: unknown;
  error?: string;
};

/** A phase's collected output. A `single` phase (fixed one-task / `tasks` of
 *  length 1 is still `multi`) exposes `.text` / `.json`; a `map` (or multi-task)
 *  phase exposes `.results` (the array) and the `.<field>` flatten sugar. */
export type PhaseOutput =
  | { kind: 'single'; task: TaskOutput }
  | { kind: 'multi'; results: TaskOutput[] };

/** The resolution context an interpolation runs against. */
export type TemplateContext = {
  args: Record<string, unknown>;
  phases: Record<string, PhaseOutput>;
  /** The current map iteration's value, keyed by the loop-variable name. */
  item?: Record<string, unknown>;
};

const REF_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Render a value reached by a dotpath into the prompt string. Strings pass
 *  through verbatim; everything else is JSON-serialized (arrays/objects/numbers
 *  /booleans) so a `{{phase.results}}` array lands as readable JSON. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Walk a dotpath of literal keys into a value. Returns `undefined` the moment
 *  a segment can't be reached (non-object parent or missing key) so the caller
 *  can raise a precise unresolved-ref error. */
function walkPath(root: unknown, segments: string[]): unknown {
  let current = root;
  for (const seg of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
    if (current === undefined) return undefined;
  }
  return current;
}

/** Flatten `item.<field>` across a map phase's per-task JSON outputs. Powers
 *  `map.over: <phaseId>.<field>`: a `find` phase whose tasks each returned
 *  `{findings:[...]}` exposes `{{find.findings}}` as the concatenation of every
 *  task's `findings` array. Tasks without parsed JSON (text-only or errored)
 *  contribute nothing. */
function flattenField(results: TaskOutput[], field: string): unknown[] {
  const out: unknown[] = [];
  for (const result of results) {
    if (result.json === null || typeof result.json !== 'object') continue;
    const value = (result.json as Record<string, unknown>)[field];
    if (Array.isArray(value)) out.push(...value);
    else if (value !== undefined) out.push(value);
  }
  return out;
}

/** Resolve a phase reference (`<phaseId>.<rest...>`) against a PhaseOutput. */
function resolvePhaseRef(phase: PhaseOutput, ref: string, rest: string[]): unknown {
  const head = rest[0];
  if (head === undefined) {
    throw new Error(`unresolved reference '{{${ref}}}': bare phase id needs a field`);
  }
  if (phase.kind === 'single') {
    if (head === 'text') return phase.task.text;
    if (head === 'json') return walkPath(phase.task.json, rest.slice(1));
    // Sugar: `{{<phaseId>.<field>}}` on a single json-output phase walks into
    // its parsed JSON (≡ `{{<phaseId>.json.<field>}}`) — so `map.over` /
    // prompts can reach a field without spelling `.json`. Missing → undefined
    // → unresolved-ref error at the call site (interpolate / resolveOverArray).
    return walkPath(phase.task.json, rest);
  }
  if (head === 'results') return phase.results;
  // Sugar: `{{<phaseId>.<field>}}` flattens item.<field> across map JSON outputs.
  return flattenField(phase.results, head);
}

/** Resolve one reference (the inside of a `{{...}}`) to its value, or throw a
 *  clear unresolved-reference error. */
function resolveRef(ref: string, ctx: TemplateContext): unknown {
  const segments = ref.split('.').map((s) => s.trim());
  const root = segments[0];
  if (root === undefined || root === '') {
    throw new Error(`unresolved reference '{{${ref}}}': empty path`);
  }
  const rest = segments.slice(1);

  if (root === 'args') {
    const value = walkPath(ctx.args, rest);
    if (value === undefined) throw new Error(`unresolved reference '{{${ref}}}': no such arg`);
    return value;
  }
  if (ctx.item !== undefined && root in ctx.item) {
    return rest.length === 0 ? ctx.item[root] : walkPath(ctx.item[root], rest);
  }
  const phase = ctx.phases[root];
  if (phase !== undefined) return resolvePhaseRef(phase, ref, rest);

  throw new Error(`unresolved reference '{{${ref}}}': unknown root '${root}'`);
}

/** Interpolate every `{{ref}}` in `template` against `ctx`. Throws on the first
 *  unresolved reference (refs validated structurally at resolve time; the engine
 *  surfaces the error as a task failure rather than guessing). */
export function interpolate(template: string, ctx: TemplateContext): string {
  return template.replace(REF_PATTERN, (_match, ref: string) => {
    const value = resolveRef(ref, ctx);
    if (value === undefined) throw new Error(`unresolved reference '{{${ref}}}'`);
    return renderValue(value);
  });
}

/** Resolve a `map.over` reference to an array. Accepts `args.<field>` or
 *  `<phaseId>.<field>` (the same grammar as `interpolate`, but the resolved
 *  value MUST be an array). Throws a clear error otherwise. */
export function resolveOverArray(over: string, ctx: TemplateContext): unknown[] {
  const value = resolveRef(over, ctx);
  if (!Array.isArray(value)) {
    throw new Error(`map.over '${over}' did not resolve to an array (got ${typeof value})`);
  }
  return value;
}
