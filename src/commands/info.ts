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

export const TOOLS_COMMAND: LocalCommand = {
  type: 'local',
  name: 'tools',
  description: 'List tools available in this session.',
  call: async (_args, ctx) => {
    if (ctx.tools.length === 0) return 'no tools loaded';
    const lines = ['tools', ''];
    const longest = Math.max(...ctx.tools.map((t) => t.name.length));
    for (const tool of ctx.tools) {
      const pad = ' '.repeat(Math.max(0, longest + 1 - tool.name.length));
      lines.push(`  ${tool.name}${pad}  ${tool.description ?? ''}`);
    }
    return lines.join('\n');
  },
};

export const SKILLS_COMMAND: LocalCommand = {
  type: 'local',
  name: 'skills',
  description: 'List skills available in this session.',
  call: async (_args, ctx) => {
    if (ctx.skills.skills.length === 0) return 'no skills loaded';
    const lines = ['skills', ''];
    const longest = Math.max(...ctx.skills.skills.map((s) => s.name.length));
    for (const skill of ctx.skills.skills) {
      const pad = ' '.repeat(Math.max(0, longest + 1 - skill.name.length));
      lines.push(`  ${skill.name}${pad}  ${skill.description ?? ''}`);
    }
    return lines.join('\n');
  },
};
