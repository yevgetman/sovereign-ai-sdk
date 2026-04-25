// Shared filesystem locations. HARNESS_HOME lets tests and deployed profiles
// isolate state; default mirrors Claude Code-style ~/.harness state.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.HARNESS_HOME ?? join(homedir(), '.harness'));
}
