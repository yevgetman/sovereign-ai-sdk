// Slash-command types. The registry is the single source of truth; every
// future surface (TUI, Telegram, Slack) should render from these shapes.

import type { SessionCost, SessionListEntry } from '../agent/sessionDb.js';
import type { CompactResult } from '../compact/compactor.js';
import type { PermissionRuleLayer } from '../config/rules.js';
import type { BudgetReport } from '../context/budget.js';
import type { ContentBlock, Message } from '../core/types.js';
import type { SkillRegistry } from '../skills/types.js';
import type { Tool } from '../tool/types.js';
import type { SessionMetrics } from '../ui/sessionSummary.js';

/** Runtime services exposed to slash command handlers. */
export type CommandContext = {
  sessionId: string;
  cwd: string;
  providerName: string;
  model: string;
  /** Bundle root, when one is loaded (null = generic-agent mode). */
  bundlePath: string | null;
  setModel: (model: string) => void;
  clearHistory: () => string;
  getCost: () => SessionCost;
  compact: () => Promise<CompactResult>;
  rollback: () => Promise<string>;
  tools: Tool<unknown, unknown>[];
  registry: CommandRegistry;
  /** Recent sessions, newest-first. Used by /resume. */
  listSessions: (limit?: number) => SessionListEntry[];
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
