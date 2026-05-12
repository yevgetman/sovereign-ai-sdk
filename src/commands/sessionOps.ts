// Session-shaped slash commands: /clear, /quit, /cost, /model.

import { formatUsd } from '../providers/pricing.js';
import type { LocalCommand } from './types.js';

export const CLEAR_COMMAND: LocalCommand = {
  type: 'local',
  name: 'clear',
  description: 'Clear conversation history and reset session cost.',
  call: async (_args, ctx) => ctx.clearHistory(),
};

export const QUIT_COMMAND: LocalCommand = {
  type: 'local',
  name: 'quit',
  aliases: ['exit'],
  description: 'Exit the harness.',
  call: async (_args, ctx) => {
    ctx.requestExit();
    return '';
  },
};

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

export const COST_COMMAND: LocalCommand = {
  type: 'local',
  name: 'cost',
  description: 'Show token usage and estimated cost for this session.',
  call: async (_args, ctx) => {
    const cost = ctx.getCost();
    return [
      'session cost',
      `  input: ${formatTokens(cost.inputTokens)} tokens`,
      `  output: ${formatTokens(cost.outputTokens)} tokens`,
      `  cache read: ${formatTokens(cost.cacheReadTokens)} tokens`,
      `  cache write: ${formatTokens(cost.cacheWriteTokens)} tokens`,
      `  estimated: ${formatUsd(cost.estimatedUsd)}`,
    ].join('\n');
  },
};

const MODEL_USAGE = '/model [<provider/model>|<model>]';

export const MODEL_COMMAND: LocalCommand = {
  type: 'local',
  name: 'model',
  description: 'Show or change the active provider/model.',
  usage: MODEL_USAGE,
  call: async (args, ctx) => {
    const trimmed = args.trim();
    if (!trimmed) {
      return `current: ${ctx.providerName}/${ctx.model}\n\nusage: ${MODEL_USAGE}`;
    }
    ctx.setModel(trimmed);
    return `model set to ${trimmed}\n(provider validates on next turn)`;
  },
};
