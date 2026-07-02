// Context budget audit (Phase 12.6). Inventories every loaded component
// that occupies space in the model's context window — system-prompt
// segments, tool schemas (native + MCP), skills, bundle context, memory
// — and flags components that exceed configurable bloat thresholds.
//
// Provides the data behind the `/context-budget` slash command and the
// `HarnessInfo` tool's optional `budget` section. Lifts ECC's
// `context-budget` skill (inventory → classify → flag → recommend) and
// trades line-count thresholds for token-count thresholds (tokens are
// what the model pays).
//
// Estimation is intentionally rough: src/core/tokenEstimate.ts uses a
// 4-chars-per-token heuristic. Provider-exact tokenization would need
// per-provider tokenizer libs and is overkill for triage.

import type { Bundle } from '../bundle/types.js';
import { estimateJsonTokens, estimateTextTokens } from '../core/tokenEstimate.js';
import type { SystemSegment } from '../core/types.js';
import type { Skill } from '../skills/types.js';
import { safeStaticToolDescription } from '../tool/staticDescription.js';
import type { Tool } from '../tool/types.js';

export type ComponentKind =
  | 'system-segment'
  | 'tool-schema'
  | 'skill'
  | 'bundle'
  | 'memory'
  /** Learning-loop spike Phase 1 — recalled instinct lessons injected in
   *  front of a user turn. Reserved as a budget category now so the recall
   *  injection can be inventoried by `/context-budget` once it is wired
   *  into the audit. */
  | 'instinct';

export type Classification = 'always' | 'sometimes' | 'rarely';

export type ComponentTokens = {
  kind: ComponentKind;
  /** A short label — system-segment label, tool name, skill name, etc. */
  name: string;
  /** Set when the component is a file (skills, bundle, memory). */
  path?: string;
  tokens: number;
  /** Configured bloat tier; null when within thresholds. */
  bloat: 'heavy' | 'extreme' | null;
  /** Triage hint — "always" means the component is loaded regardless of
   *  task; "sometimes" means it's gated and may not be active in this
   *  session; "rarely" means it appears unused given current state. */
  classification: Classification;
};

export type BudgetReport = {
  components: ComponentTokens[];
  totals: {
    estimated: number;
    /** Caller-supplied window size (e.g., the active model's context len). */
    window?: number;
    /** estimated / window when the window is known. */
    utilization?: number;
  };
};

export type BudgetThresholds = {
  skill: { heavy: number; extreme: number };
  toolSchema: { heavy: number; extreme: number };
  systemSegment: { heavy: number; extreme: number };
  memory: { heavy: number };
  bundle: { heavy: number; extreme: number };
};

/** Defaults picked from ECC's experience (their thresholds in lines:
 *  >200 lines per agent ≈ 800 tokens, >400 lines per skill ≈ 1600). We
 *  set a stricter "heavy" tier and reserve "extreme" for genuine bloat. */
export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {
  skill: { heavy: 300, extreme: 800 },
  toolSchema: { heavy: 500, extreme: 1500 },
  systemSegment: { heavy: 800, extreme: 2000 },
  memory: { heavy: 1000 },
  bundle: { heavy: 1500, extreme: 3000 },
};

export type AuditOptions = {
  systemSegments?: readonly SystemSegment[];
  tools?: readonly Tool<unknown, unknown>[];
  skills?: readonly Skill[];
  bundle?: Bundle;
  memory?: ReadonlyArray<{ name: string; path: string; chars: number }>;
  /** Override thresholds via config. Missing keys fall back to defaults. */
  thresholds?: Partial<BudgetThresholds>;
  /** Active toolset names — used to classify skills' visibility. When
   *  unknown, classification falls through to "sometimes" or "rarely". */
  activeToolNames?: readonly string[];
  /** Caller-known context window in tokens; sets the `utilization` ratio. */
  contextWindow?: number;
};

export function auditContextBudget(opts: AuditOptions): BudgetReport {
  const thresholds = mergeThresholds(opts.thresholds);
  const activeTools = new Set(opts.activeToolNames ?? []);
  const components: ComponentTokens[] = [];

  for (const [index, segment] of (opts.systemSegments ?? []).entries()) {
    const tokens = estimateTextTokens(segment.text);
    components.push({
      kind: 'system-segment',
      name: segmentLabel(segment.text, index),
      tokens,
      bloat: bloatFor(tokens, thresholds.systemSegment),
      classification: 'always',
    });
  }

  for (const tool of opts.tools ?? []) {
    const tokens = estimateToolSchemaTokens(tool);
    components.push({
      kind: 'tool-schema',
      name: tool.name,
      tokens,
      bloat: bloatFor(tokens, thresholds.toolSchema),
      classification: classifyTool(tool, activeTools),
    });
  }

  for (const skill of opts.skills ?? []) {
    const tokens = estimateTextTokens(skill.body) + estimateTextTokens(skill.whenToUse);
    components.push({
      kind: 'skill',
      name: skill.name,
      path: skill.path,
      tokens,
      bloat: bloatFor(tokens, thresholds.skill),
      classification: classifySkill(skill, activeTools),
    });
  }

  if (opts.bundle?.state.context !== undefined && opts.bundle.state.context !== null) {
    const tokens = estimateTextTokens(opts.bundle.state.context);
    components.push({
      kind: 'bundle',
      name: 'state/CONTEXT.md',
      tokens,
      bloat: bloatFor(tokens, thresholds.bundle),
      classification: 'always',
    });
  }

  for (const file of opts.memory ?? []) {
    const tokens = Math.max(1, Math.ceil(file.chars / 4));
    components.push({
      kind: 'memory',
      name: file.name,
      path: file.path,
      tokens,
      bloat: tokens > thresholds.memory.heavy ? 'heavy' : null,
      classification: 'always',
    });
  }

  const estimated = components.reduce((sum, c) => sum + c.tokens, 0);
  return {
    components,
    totals: {
      estimated,
      ...(opts.contextWindow !== undefined ? { window: opts.contextWindow } : {}),
      ...(opts.contextWindow !== undefined && opts.contextWindow > 0
        ? { utilization: estimated / opts.contextWindow }
        : {}),
    },
  };
}

function mergeThresholds(override: Partial<BudgetThresholds> | undefined): BudgetThresholds {
  if (!override) return DEFAULT_BUDGET_THRESHOLDS;
  return {
    skill: { ...DEFAULT_BUDGET_THRESHOLDS.skill, ...override.skill },
    toolSchema: { ...DEFAULT_BUDGET_THRESHOLDS.toolSchema, ...override.toolSchema },
    systemSegment: {
      ...DEFAULT_BUDGET_THRESHOLDS.systemSegment,
      ...override.systemSegment,
    },
    memory: { ...DEFAULT_BUDGET_THRESHOLDS.memory, ...override.memory },
    bundle: { ...DEFAULT_BUDGET_THRESHOLDS.bundle, ...override.bundle },
  };
}

function bloatFor(
  tokens: number,
  band: { heavy: number; extreme?: number },
): 'heavy' | 'extreme' | null {
  if (band.extreme !== undefined && tokens > band.extreme) return 'extreme';
  if (tokens > band.heavy) return 'heavy';
  return null;
}

/** First non-empty line, capped at 60 chars, used as a stable label for
 *  a system-prompt segment. Falls back to its index when the segment is
 *  empty (defensive — segments shouldn't be empty in practice). */
function segmentLabel(text: string, index: number): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length > 0) {
      return line.length > 60 ? `${line.slice(0, 60)}…` : line;
    }
  }
  return `segment[${index}]`;
}

function estimateToolSchemaTokens(tool: Tool<unknown, unknown>): number {
  // Description plus a rough estimate of the input schema's serialized
  // size. MCP tools carry inputJSONSchema; native tools' Zod is
  // converted to JSON schema upstream — use a coarse JSON estimate so
  // the rough order of magnitude is right.
  //
  // Resolve the description through the shared crash-safe helper: an
  // input-dependent throw, an async (possibly rejecting) description, or a
  // non-string return all degrade to the tool name — the same string the
  // provider request actually carries here — so the audit can never leave an
  // unhandled rejection that crashes the process (see tool/staticDescription.ts).
  let total = estimateTextTokens(safeStaticToolDescription(tool));
  if (tool.inputJSONSchema !== undefined) {
    total += estimateJsonTokens(tool.inputJSONSchema);
  } else {
    // Heuristic: most native tool schemas serialize to roughly 200 tokens.
    total += 200;
  }
  total += estimateTextTokens(tool.name);
  return total;
}

function classifyTool(
  tool: Tool<unknown, unknown>,
  activeTools: ReadonlySet<string>,
): Classification {
  if (tool.shouldDefer === true) return 'sometimes';
  if (activeTools.size === 0) return 'always';
  return activeTools.has(tool.name) ? 'always' : 'sometimes';
}

function classifySkill(skill: Skill, activeTools: ReadonlySet<string>): Classification {
  const requiresTools = skill.metadata.harness.requiresTools;
  const fallbackForTools = skill.metadata.harness.fallbackForTools;
  if (requiresTools.length > 0) {
    const allActive = requiresTools.every((t) => activeTools.has(t));
    return allActive ? 'always' : 'rarely';
  }
  if (fallbackForTools.length > 0) {
    const intersect = fallbackForTools.some((t) => activeTools.has(t));
    return intersect ? 'rarely' : 'sometimes';
  }
  return 'sometimes';
}

/** Format a BudgetReport for human + model consumption. Used by the
 *  `/context-budget` slash command. */
export function formatBudgetReport(report: BudgetReport): string {
  const lines: string[] = [];
  const { totals, components } = report;
  if (totals.window !== undefined && totals.utilization !== undefined) {
    const pct = (totals.utilization * 100).toFixed(1);
    lines.push(
      `total estimate: ${totals.estimated.toLocaleString()} tokens / ${totals.window.toLocaleString()} window (${pct}%)`,
    );
  } else {
    lines.push(`total estimate: ${totals.estimated.toLocaleString()} tokens`);
  }
  for (const kind of ['system-segment', 'tool-schema', 'skill', 'bundle', 'memory'] as const) {
    const subset = components.filter((c) => c.kind === kind);
    if (subset.length === 0) continue;
    const subtotal = subset.reduce((sum, c) => sum + c.tokens, 0);
    lines.push('', `${labelForKind(kind)}: ${subtotal.toLocaleString()} tokens`);
    for (const c of subset.sort((a, b) => b.tokens - a.tokens)) {
      const flag = c.bloat ? ` (${c.bloat})` : '';
      const cls = c.classification !== 'always' ? ` [${c.classification}]` : '';
      lines.push(`  ${c.name}: ${c.tokens.toLocaleString()}${flag}${cls}`);
    }
  }
  return lines.join('\n');
}

function labelForKind(kind: ComponentKind): string {
  switch (kind) {
    case 'system-segment':
      return 'system prompt';
    case 'tool-schema':
      return 'tool schemas';
    case 'skill':
      return 'skills';
    case 'bundle':
      return 'bundle context';
    case 'memory':
      return 'memory files';
    case 'instinct':
      return 'instinct lessons';
  }
}
