// Session-shaped slash commands: /clear, /quit, /cost, /model.

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
