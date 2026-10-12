import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FilesystemSkillStore } from '@yevgetman/sov-sdk/skills/store';
import type { SkillTrustTier } from '@yevgetman/sov-sdk/skills/types';

/** Source hosts use the packaged Node/Bun worker. A compiled SOV binary
 *  re-enters its embedded helper before config, profile or provider startup. */
export function createSovSkillStore(
  root: string,
  trustTier: SkillTrustTier = 'agent-created',
): FilesystemSkillStore {
  return new FilesystemSkillStore({
    root,
    trustTier,
    ...(!existsSync(fileURLToPath(import.meta.url))
      ? {
          workerCommand: { executable: process.execPath, args: ['--sov-skill-store-worker'] },
        }
      : {}),
  });
}
