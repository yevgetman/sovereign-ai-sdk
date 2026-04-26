// Slash-command types. The registry is the single source of truth; every
// future surface (TUI, Telegram, Slack) should render from these shapes.

import type { SessionCost } from '../agent/sessionDb.js';
import type { CompactResult } from '../compact/compactor.js';
import type { ContentBlock } from '../core/types.js';
import type { Tool } from '../tool/types.js';

export type CommandContext = {
  sessionId: string;
  cwd: string;
  providerName: string;
  model: string;
  setModel: (model: string) => void;
  clearHistory: () => void;
  getCost: () => SessionCost;
  compact: () => Promise<CompactResult>;
  rollback: () => Promise<string>;
  tools: Tool<unknown, unknown>[];
  registry: CommandRegistry;
};

export type LocalCommand = {
  type: 'local';
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  call: (args: string, ctx: CommandContext) => Promise<string>;
};

export type PromptCommand = {
  type: 'prompt';
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  allowedTools?: string[];
  getPromptForCommand: (args: string, ctx: CommandContext) => Promise<ContentBlock[]>;
};

export type LocalJSXCommand = {
  type: 'local-jsx';
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  call: (args: string, ctx: CommandContext) => Promise<unknown>;
};

export type SlashCommand = LocalCommand | PromptCommand | LocalJSXCommand;

export type CommandRegistry = ReadonlyMap<string, SlashCommand>;

export type CommandDispatchResult =
  | { kind: 'local'; output: string }
  | { kind: 'prompt'; command: PromptCommand; content: ContentBlock[] }
  | { kind: 'unknown'; output: string };
