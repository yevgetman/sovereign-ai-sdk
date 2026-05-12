// Slash-command dispatch tests. Phase 16.0c SD2: each Wave 1 slash command
// gets a dedicated, isolated case that exercises the headless `sov dispatch`
// surface and asserts on literal output substrings via the string-match
// judge. The previous agent-turn-driven cases (/context-budget, /init,
// /commit, etc.) exercised pathways that don't exist in dispatch mode and
// will return when an agent-headless surface is reintroduced.

import type { SemanticTest } from '../framework/types.js';

const COMMAND_TIMEOUT_MS = 30_000;

export const tests: SemanticTest[] = [
  {
    id: 'commands.help',
    name: '/help lists all Wave 1 commands',
    description:
      'Guards against the slash registry being un-wired or a Wave 1 command being dropped.',
    category: 'commands',
    prompt: ['/help'],
    judgeCriteria: {
      mustSatisfy: [
        'slash commands',
        '/help',
        '/clear',
        '/cost',
        '/about',
        '/config',
        '/model',
        '/permissions',
        '/quit',
        '/tools',
        '/skills',
      ],
      shouldNot: ['unknown command'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
  {
    id: 'commands.about',
    name: '/about prints harness identity, profile, provider, model, session',
    description:
      'Guards against /about losing one of its labeled rows (profile/provider/model/session).',
    category: 'commands',
    prompt: ['/about'],
    judgeCriteria: {
      mustSatisfy: ['sovereign-ai-harness', 'profile:', 'provider:', 'model:', 'session:'],
      shouldNot: ['unknown command'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
  {
    id: 'commands.cost',
    name: '/cost reports zeros in a fresh headless session',
    description:
      'Headless dispatch wires getLatestCost() to a zero fallback. This guards against the ' +
      'zero-cost contract (no live UI cost tracking) and the formatted output structure.',
    category: 'commands',
    prompt: ['/cost'],
    judgeCriteria: {
      mustSatisfy: ['session cost', 'input: 0 tokens', 'output: 0 tokens', '$0.0000'],
      shouldNot: ['unknown command'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
  {
    id: 'commands.model',
    name: '/model shows current and accepts a new model',
    description:
      'Two-turn case. Turn 1: no-arg /model prints "current: <provider>/<model>" and usage. ' +
      'Turn 2: /model <name> reports "model set to <name>" and the provider-validates-next-turn hint.',
    category: 'commands',
    prompt: ['/model', '/model claude-haiku-4-5-20251001'],
    judgeCriteria: {
      mustSatisfy: [
        'current:',
        'usage:',
        'model set to claude-haiku-4-5-20251001',
        'provider validates on next turn',
      ],
      shouldNot: ['unknown command'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
  {
    id: 'commands.config',
    name: '/config show and /config path round-trip cleanly',
    description:
      'Two-turn case. /config show emits the redacted JSON (an empty {} in the sandbox). ' +
      '/config path emits the resolved config file path. Guards against either verb regressing ' +
      'or printing the usage banner by mistake.',
    category: 'commands',
    prompt: ['/config show', '/config path'],
    judgeCriteria: {
      mustSatisfy: ['{}', 'config.json'],
      shouldNot: ['unknown command', 'usage:'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
  {
    id: 'commands.permissions',
    name: '/permissions reports the current mode',
    description:
      'Guards against the permissions snapshot accessor regressing. In the sandbox the user ' +
      'config is {} so mode resolves to "default".',
    category: 'commands',
    prompt: ['/permissions'],
    judgeCriteria: {
      mustSatisfy: ['mode: default'],
      shouldNot: ['unknown command'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
  {
    id: 'commands.tools',
    name: '/tools lists the default-bundle tool pool',
    description:
      'Guards against /tools producing an empty pool or losing core tools. The default bundle ' +
      'ships Bash, FileRead, FileWrite, Grep — at minimum the header and one core tool name ' +
      'must appear.',
    category: 'commands',
    prompt: ['/tools'],
    judgeCriteria: {
      mustSatisfy: ['tools', 'Bash', 'FileRead'],
      shouldNot: ['unknown command', 'no tools loaded'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
  {
    id: 'commands.skills',
    name: '/skills lists the default-bundle skill catalog',
    description:
      'Guards against the skill loader silently returning nothing. The default bundle ships ' +
      '"review", "security-audit", and "summarize" skills — the header and at least one ' +
      'skill name must appear.',
    category: 'commands',
    prompt: ['/skills'],
    judgeCriteria: {
      mustSatisfy: ['skills', 'summarize'],
      shouldNot: ['unknown command', 'no skills loaded'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
  {
    id: 'commands.clear',
    name: '/clear emits the cleared-history confirmation',
    description:
      'Guards against the /clear LocalCommand losing its return string. In a fresh session ' +
      'history length is 0, so the message is "history cleared (0 messages)".',
    category: 'commands',
    prompt: ['/clear'],
    judgeCriteria: {
      mustSatisfy: ['history cleared'],
      shouldNot: ['unknown command'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
  {
    id: 'commands.clear-resets-cost',
    name: '/clear leaves /cost at zero (idempotent in a zero-cost session)',
    description:
      'Three-turn case. /cost (before) shows zeros, /clear runs, /cost (after) still shows ' +
      'zeros. In the headless dispatch surface there is no live cost tracker, so this case ' +
      'guards that /clear neither inflates nor errors the subsequent /cost output.',
    category: 'commands',
    prompt: ['/cost', '/clear', '/cost'],
    judgeCriteria: {
      mustSatisfy: ['input: 0 tokens', 'history cleared', '$0.0000'],
      shouldNot: ['unknown command'],
    },
    timeoutMs: COMMAND_TIMEOUT_MS,
  },
];
