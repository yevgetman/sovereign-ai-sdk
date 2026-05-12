// Info-shaped slash commands: /about, /tools, /skills, /permissions.

import type { LocalCommand } from './types.js';

const HARNESS_NAME = 'sovereign-ai-harness';

export const ABOUT_COMMAND: LocalCommand = {
  type: 'local',
  name: 'about',
  description: 'Show harness identity, profile, provider, and bundle.',
  call: async (_args, ctx) => {
    const lines = [
      HARNESS_NAME,
      `profile: ${ctx.profileName}`,
      `harness home: ${ctx.harnessHome}`,
      `provider: ${ctx.providerName}`,
      `model: ${ctx.model}`,
      `bundle: ${ctx.bundlePath ?? 'no bundle'}`,
      `cwd: ${ctx.cwd}`,
      `session: ${ctx.sessionId}`,
    ];
    return lines.join('\n');
  },
};
