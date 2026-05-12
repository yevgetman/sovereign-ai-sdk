// Slash-command types. The registry is the single source of truth; every
// future surface (TUI, Telegram, Slack) renders from these shapes.

import type { PermissionRuleLayer } from '../config/rules.js';
import type { SkillRegistry } from '../skills/types.js';
import type { Tool } from '../tool/types.js';

export type SessionCost = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedUsd: number;
};

export const zeroCost: SessionCost = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedUsd: 0,
};

export type PermissionsSnapshot = {
  readonly mode: 'default' | 'ask' | 'bypass';
  readonly layers: ReadonlyArray<PermissionRuleLayer>;
};

export type CommandContext = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly providerName: string;
  readonly model: string;
  readonly bundlePath: string | null;
  readonly harnessHome: string;
  readonly profileName: string;
  readonly setModel: (m: string) => void;
  readonly clearHistory: () => string;
  readonly getCost: () => SessionCost;
  readonly tools: ReadonlyArray<Tool<unknown, unknown>>;
  readonly skills: SkillRegistry;
  readonly getPermissions: () => PermissionsSnapshot;
  readonly registry: CommandRegistry;
  readonly requestExit: () => void;
};

export type LocalCommand = {
  readonly type: 'local';
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly description: string;
  readonly usage?: string;
  readonly call: (args: string, ctx: CommandContext) => Promise<string>;
};

export type SlashCommand = LocalCommand;

export type CommandRegistry = ReadonlyMap<string, SlashCommand>;

export type CommandDispatchResult =
  | { readonly kind: 'local'; readonly output: string }
  | { readonly kind: 'unknown'; readonly output: string };
