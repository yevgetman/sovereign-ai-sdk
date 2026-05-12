// /config slash command — show, path, get, set, unset. Pure on
// src/config/store, so behavior matches the `sovereign config` CLI verbs.

import {
  formatValue,
  getAt,
  parseValueLiteral,
  readConfig,
  redactSecrets,
  resolveConfigPath,
  setAt,
  unsetAt,
  writeConfig,
} from '../config/store.js';
import type { LocalCommand } from './types.js';

const USAGE = '/config [show | path | get <dotpath> | set <dotpath> <value> | unset <dotpath>]';

export const CONFIG_COMMAND: LocalCommand = {
  type: 'local',
  name: 'config',
  description: 'View or change durable user-level config (~/.harness/config.json).',
  usage: USAGE,
  call: async (args, _ctx) => handleConfig(args),
};

async function handleConfig(args: string): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const verb = parts[0] ?? 'show';

  if (verb === 'show' || verb === '') {
    const cfg = readConfig();
    return JSON.stringify(redactSecrets(cfg), null, 2);
  }

  if (verb === 'path') {
    return resolveConfigPath();
  }

  if (verb === 'get') {
    const path = parts[1];
    if (!path) return `usage: ${USAGE}`;
    const cfg = readConfig();
    const value = getAt(cfg, path);
    return value === undefined ? 'undefined' : formatValue(value);
  }

  if (verb === 'set') {
    const path = parts[1];
    if (!path || parts.length < 3) return `usage: ${USAGE}`;
    const raw = parts.slice(2).join(' ');
    const value = parseValueLiteral(raw);
    const cfg = readConfig();
    const updated = setAt(cfg, path, value);
    writeConfig(updated);
    return `set ${path} = ${formatValue(value)}`;
  }

  if (verb === 'unset') {
    const path = parts[1];
    if (!path) return `usage: ${USAGE}`;
    const cfg = readConfig();
    const updated = unsetAt(cfg, path);
    writeConfig(updated);
    return `unset ${path}`;
  }

  return `usage: ${USAGE}`;
}
