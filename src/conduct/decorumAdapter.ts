// Decorum no longer supplies the conduct engine. The SDK Conduct Port stays.
// Nothing in this file imports @yevgetman/decorum.

/** Shown when a gateway config still names a conduct pack. */
export const DECORUM_RETIRED =
  'Decorum is deprecated. The conduct port stays empty. This build does not load a conduct pack.';

/**
 * Retired. Calling this used to build a decorum ConductProvider.
 * It now refuses, so a caller cannot boot a governed turn by accident.
 */
export function createDecorumAdapter(): never {
  throw new Error(DECORUM_RETIRED);
}
