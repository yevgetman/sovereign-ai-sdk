// Pure argv scanner for the top-level `-p/--profile` flag. Lifted out of
// `src/main.ts` so it can be unit-tested without triggering main's top-level
// side effects (loadPackageEnv, the live HARNESS_HOME assignment, etc.).
//
// Phase 10.7. Per Invariant #11 the actual env mutation happens at the call
// site in main.ts before any module that captures HARNESS_HOME at load time;
// this module returns just the parsed name + a cleaned argv copy.

import { DEFAULT_PROFILE_NAME, assertProfileName } from '@yevgetman/sov-sdk/config/paths';

const TOP_LEVEL_SUBCOMMANDS = new Set(['chat', 'config', 'upgrade', 'profile', 'help']);

export type ProfileFlagParse = {
  /** Raw flag value when supplied, undefined when no flag was present in argv. */
  flagValue: string | undefined;
  /** argv with the flag (and its value, when separate) removed. */
  rest: string[];
};

/**
 * Walk argv between `argv[2]` and the first subcommand token, looking for
 * `-p <name>`, `--profile <name>`, or `--profile=<name>`. The first match
 * wins and is removed from the returned argv copy. Tokens that aren't the
 * profile flag and aren't a subcommand are left in place — top-level
 * commander options (e.g. `--help`, `--version`) flow through unchanged.
 *
 * Validates the name with `assertProfileName` so a typo fails loudly at
 * parse time. The reserved `'default'` name is allowed verbatim (it pins
 * the run to the unscoped base state root).
 */
export function parseProfileFlag(argv: string[]): ProfileFlagParse {
  const rest = [...argv];
  for (let i = 2; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (TOP_LEVEL_SUBCOMMANDS.has(arg)) break;
    if (arg === '-p' || arg === '--profile') {
      const value = rest[i + 1];
      if (value === undefined || value.length === 0) {
        throw new Error(`${arg} requires a profile name`);
      }
      if (value !== DEFAULT_PROFILE_NAME) assertProfileName(value);
      rest.splice(i, 2);
      return { flagValue: value, rest };
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (value.length === 0) {
        throw new Error('--profile requires a profile name');
      }
      if (value !== DEFAULT_PROFILE_NAME) assertProfileName(value);
      rest.splice(i, 1);
      return { flagValue: value, rest };
    }
  }
  return { flagValue: undefined, rest };
}
