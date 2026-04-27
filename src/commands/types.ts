// Slash-command types. The registry is the single source of truth; every
// future surface (TUI, Telegram, Slack) should render from these shapes.

import type { SessionCost } from '../agent/sessionDb.js';
import type { CompactResult } from '../compact/compactor.js';
import type { ContentBlock } from '../core/types.js';
import type { Tool } from '../tool/types.js';

/** Runtime services exposed to slash command handlers. */
export type CommandContext = {
  sessionId: string;
  cwd: string;
  providerName: string;
  model: string;
  setModel: (model: string) => void;
  clearHistory: () => string;
  getCost: () => SessionCost;
  compact: () => Promise<CompactResult>;
  rollback: () => Promise<string>;
  tools: Tool<unknown, unknown>[];
  registry: CommandRegistry;
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
