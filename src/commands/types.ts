// Slash-command types. The registry is the single source of truth; every
// future surface (TUI, Telegram, Slack) should render from these shapes.

import type { SessionCost, SessionListEntry } from '../agent/sessionDb.js';
import type { CompactResult } from '../compact/compactor.js';
import type { PermissionRuleLayer } from '../config/rules.js';
import type { BudgetReport } from '../context/budget.js';
import type { ContentBlock, Message } from '../core/types.js';
import type { RoutingStatsSnapshot } from '../router/stats.js';
import type { SkillRegistry } from '../skills/types.js';
import type { Tool } from '../tool/types.js';
import type { SessionMetrics } from '../ui/sessionSummary.js';

/** One option in a server-emitted picker. M11.5. The optional
 *  `valueColumn` and `badge` are populated by the 2026-05-24 config UX
 *  rebuild — the same PickerCard component renders config-submenu rows
 *  (current value right-aligned, ✓ live / ⟳ next session badge after the
 *  value). Both stay optional so existing `/model`, `/resume`, `/export`,
 *  `/theme` callers keep working unchanged. */
export type PickerOpenItem = {
  label: string;
  value: string;
  hint?: string;
  /** Right-aligned current-value column (config picker rows). */
  valueColumn?: string;
  /** Reload semantics badge (`live` = ✓ green; `reload` = ⟳ dim). */
  badge?: 'live' | 'reload';
};

/** Payload that a server-mode picker command emits in lieu of running an
 *  in-process `pick()`. The TUI renders an inline card from this shape;
 *  on selection it re-dispatches `/<onSelect.command> <value>` as a fresh
 *  slash command (ADR M11.5-03). M11.5. */
export type PickerOpenConfig = {
  title: string;
  subtitle?: string;
  items: PickerOpenItem[];
  initial?: number;
  /** Command to dispatch with the selected value as args. */
  onSelect: { command: string };
  /** 2026-05-24 patch — back-navigation. When present, the TUI
   *  re-dispatches this command on backspace so the user can
   *  navigate back to the previous menu without re-running /config.
   *  Absence means there's no parent (root menu, or non-hierarchical
   *  picker like /model / /resume / /export / /theme). */
  onBack?: { command: string };
};

/** 2026-05-24 — Config UX rebuild. Parallel to `PickerOpenConfig` but for
 *  free-text edits (string, number, secret). The TUI renders an InputCard;
 *  on Enter it re-dispatches `/<onSubmit.command> <typed>` as a fresh slash
 *  command. `masked: true` displays bullets (API keys, secrets). */
export type InputOpenConfig = {
  title: string;
  subtitle?: string;
  initial?: string;
  placeholder?: string;
  masked?: boolean;
  /** Slash command to re-dispatch with the typed value as args. */
  onSubmit: { command: string };
  /** 2026-05-24 patch — back-navigation. When present, Esc on the
   *  InputCard re-dispatches this command instead of cancelling
   *  outright. Symmetric with `PickerOpenConfig.onBack`. */
  onBack?: { command: string };
};

/** Runtime services exposed to slash command handlers. */
export type CommandContext = {
  sessionId: string;
  cwd: string;
  providerName: string;
  model: string;
  /** Bundle root, when one is loaded (null = generic-agent mode). */
  bundlePath: string | null;
  setModel: (model: string) => void;
  /** 2026-05-24 patch — live-apply hook for `permissionMode`. Mutates
   *  runtime.permissionMode so the next turn's permission gate reads
   *  the new mode. Optional so non-server surfaces (headless dispatch,
   *  sov config standalone) can omit it; live-apply degrades to
   *  persisted-only when undefined. */
  setPermissionMode?: (mode: 'default' | 'ask' | 'bypass') => void;
  /** 2026-05-24 patch — live-apply hook for `microcompaction.*` and
   *  `compaction.proactiveThresholdPct`. Re-reads userSettings via
   *  readConfig() and updates the runtime's cached fields:
   *  `runtime.microcompactConfig` (rebuilt via buildMicrocompactConfig)
   *  and `runtime.proactiveCompactThreshold` (recomputed). The turns
   *  route reads both per-request, so the next turn picks up the new
   *  values without a restart. Optional so non-server surfaces can
   *  omit it; hooks degrade to persisted-only when undefined. */
  refreshRuntimeFromConfig?: () => void;
  clearHistory: () => string;
  getCost: () => SessionCost;
  compact: () => Promise<CompactResult>;
  rollback: () => Promise<string>;
  tools: Tool<unknown, unknown>[];
  registry: CommandRegistry;
  /** Recent sessions, newest-first. Used by /resume. */
  listSessions: (limit?: number) => SessionListEntry[];
  /** Phase 13.3 follow-up (Item 16) — opportunistic phantom-row cleanup
   *  triggered from /review activity when the queue exceeds threshold.
   *  Returns the number of phantom rows deleted. Optional so existing
   *  CommandContext consumers (and tests) can omit it; the activity
   *  verb skips cleanup when undefined. */
  cleanupPhantomReviews?: () => number;
  /** Active session metrics — same shape the goodbye summary uses, but
   *  evaluated mid-session for /stats. */
  getMetrics: () => Omit<SessionMetrics, 'endedAtMs'>;
  /** Skill registry filtered to the current session's active toolsets. */
  skills: SkillRegistry;
  /** Last assistant message's plain text, or null when the latest
   *  assistant turn was tool-only / image-only / not yet emitted. */
  getLastAssistantText: () => string | null;
  /** Defensive copy of the in-memory history (user + assistant
   *  messages, including resumed-from-DB ones). Used by /export. */
  getMessages: () => Message[];
  /** Permission state surface for /permissions. */
  getPermissions: () => {
    mode: 'default' | 'ask' | 'bypass';
    /** Session-scoped allow rules accumulated from `[a]lways` answers. */
    alwaysAllow: string[];
    /** Persistent rule layers loaded from settings.json files. */
    layers: PermissionRuleLayer[];
  };
  /** Request graceful REPL exit. The REPL loop will close after the
   *  current command's output prints. */
  requestExit: () => void;
  /** Phase 13.2 — task system manager. /tasks reads this directly to
   *  list / show / stop tasks for the current session. */
  taskManager?: import('../tasks/manager.js').TaskManager;
  /** Phase 13.3 — review manager. Exposed so /review slash command and
   *  propose tools can interact with the review system. */
  reviewManager?: import('../review/manager.js').ReviewManager;
  /** Phase 13.3 — harness-home root for review/* paths. /review reads this
   *  to locate $HARNESS_HOME/review/pending|approved|rejected/. */
  harnessHome?: string;
  /** Phase 12.6: per-component context-window audit. Backs the
   *  `/context-budget` command. */
  getBudgetReport: () => BudgetReport;
  /** Re-render the Nth-most-recent tool block with no truncation.
   *  Returns true when a block at that position exists (and was
   *  written to stdout via the slot's expand path), false when N is
   *  out of range. Backs the `/expand` command — the user runs
   *  `/expand` (most recent) or `/expand 3` (third-most-recent) to
   *  see full content for blocks the inline renderer truncated. */
  expandToolBlock: (n: number) => { ok: boolean; total: number };
  /** Set by the REPL when a turn is paused at the tool-call checkin limit.
   *  Calling it clears the pending flag and resumes the model turn.
   *  Undefined when no checkin is pending. */
  resumeCheckin?: () => Promise<void>;
  /** M11.5 — server-mode picker capability. When defined, picker-driven
   *  commands (`/model`, `/resume`, `/export`) emit a `pickerOpen` side-
   *  effect instead of running the in-process raw-mode `pick()`. When
   *  undefined (REPL surface), commands fall back to the legacy `pick()`
   *  flow. ADR M11.5-01 (capability detection). */
  requestPicker?: (config: PickerOpenConfig) => void;
  /** Backlog #46 — server-mode theme-change notification. When defined,
   *  `/theme <name>` records the chosen theme as a side-effect so the TUI
   *  can apply it client-side (the TS-side singleton update from
   *  applyAndPersistTheme has no effect on the Go renderer). When undefined
   *  (REPL surface), the side-effect isn't emitted; the singleton update +
   *  config persist drive everything the REPL renderer needs. */
  recordThemeChange?: (name: string) => void;
  /** 2026-05-24 — Config UX rebuild. Server-mode free-text editor open
   *  request. The TUI renders an InputCard from this payload; on Enter
   *  it re-dispatches `/<onSubmit.command> <typed>`. Undefined on REPL
   *  surfaces (no inline editor). Mirrors `requestPicker`. */
  requestInput?: (config: InputOpenConfig) => void;
  /** 2026-05-24 — Config UX rebuild. Server-mode verbose-mode toggle
   *  notification. `/config set verbose <bool>` records the new value
   *  so the TUI can flip its toolcard renderer (compact one-liner vs.
   *  full bordered output). Undefined on REPL surfaces — the legacy
   *  REPL has its own raw-output gate driven by CLI flags. */
  recordVerboseChange?: (value: boolean) => void;
  /** 2026-05-24 — Config UX rebuild. True when the dispatcher runs inside
   *  `sov config` standalone mode (no active runtime / agent loop).
   *  Live-apply hooks treat this as "no session to apply to" and return
   *  'persisted-only'; the toast collapses to plain "saved". Undefined or
   *  false on every in-session surface (REPL, server, dispatch). */
  isConfigStandalone?: boolean;
  /** Phase 2 T9 — per-session (default) or cross-session (--all) routing-atom
   *  breakdown for `/routing-stats`. Returns the aggregated snapshot from
   *  `computeRoutingStats(rows)`. Optional so surfaces without a sessionDb
   *  (current dispatch headless mode) can omit it; the command surfaces a
   *  friendly fallback when undefined. */
  getRoutingStats?: (opts?: { all?: boolean }) => RoutingStatsSnapshot;
};

/** Slash command that runs locally and returns display text. */
export type LocalCommand = {
  type: 'local';
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  call: (args: string, ctx: CommandContext) => Promise<string>;
};

/** Slash command that becomes a model turn, optionally with narrowed tools. */
export type PromptCommand = {
  type: 'prompt';
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  allowedTools?: string[];
  getPromptForCommand: (args: string, ctx: CommandContext) => Promise<ContentBlock[]>;
};

/** Future rendered local command surface; kept distinct from plain text commands. */
export type LocalJSXCommand = {
  type: 'local-jsx';
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  call: (args: string, ctx: CommandContext) => Promise<unknown>;
};

/** Any command registered in the slash-command registry. */
export type SlashCommand = LocalCommand | PromptCommand | LocalJSXCommand;

/** Name and alias lookup map for slash commands. */
export type CommandRegistry = ReadonlyMap<string, SlashCommand>;

/** Normalized dispatch result consumed by the REPL. */
export type CommandDispatchResult =
  | { kind: 'local'; output: string }
  | { kind: 'prompt'; command: PromptCommand; content: ContentBlock[] }
  | { kind: 'unknown'; output: string };
