import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const operation of ['catalog', 'direct', 'reload', 'guard']) {
  test(`bounded ${operation} read rejects a transient outside ancestor restored after stat`, () => {
    const result = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `
          import { createRequire, syncBuiltinESMExports } from 'node:module';
          import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
          import { tmpdir } from 'node:os';
          import { join } from 'node:path';
          import { loadSkills, loadSkillFromPath, reloadSkill } from '@yevgetman/sov-sdk/skills/loader';
          import { guardSkillLoad } from '@yevgetman/sov-sdk/skills/guard';
          const operation = process.argv[1];
          const fs = createRequire(import.meta.url)('node:fs/promises');
          const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-hidden-read-')));
          const project = join(root, 'project');
          const folder = join(project, '.agents', 'skills', 'safe');
          const main = join(folder, 'SKILL.md');
          const resourceFolder = join(folder, 'references');
          const targetFolder = operation === 'guard' ? resourceFolder : folder;
          const target = operation === 'guard' ? join(resourceFolder, 'note.txt') : main;
          const outside = join(root, 'outside');
          const text = name => '---\\nname: ' + name + '\\ndescription: Safe fixture\\n---\\n' + name + ' body\\n';
          mkdirSync(join(project, '.git'), { recursive: true });
          mkdirSync(resourceFolder, { recursive: true });
          mkdirSync(outside, { recursive: true });
          writeFileSync(main, text('inside'));
          writeFileSync(join(resourceFolder, 'note.txt'), operation === 'guard' ? 'Do not read ~/.ssh' : 'Safe reference');
          writeFileSync(join(outside, 'SKILL.md'), text('outside'));
          writeFileSync(join(outside, 'note.txt'), 'Harmless replacement content');
          // Reload needs an accepted baseline without the dangerous reference.
          if (operation === 'reload') writeFileSync(join(resourceFolder, 'note.txt'), 'Safe reference');
          const baseline = operation === 'reload'
            ? await loadSkillFromPath(main, { source: 'project', trustTier: 'trusted' }) : undefined;
          if (operation === 'reload' && !baseline) throw new Error('missing reload fixture');
          const originalOpen = fs.open;
          const originalStat = fs.stat;
          let swapped = false;
          let attempted = false;
          fs.open = async (path, ...args) => {
            if (path === target && !attempted) {
              renameSync(targetFolder, targetFolder + '-accepted');
              symlinkSync(outside, targetFolder);
              swapped = attempted = true;
            }
            return originalOpen(path, ...args);
          };
          fs.stat = async (path, ...args) => {
            const info = await originalStat(path, ...args);
            if (path === target && swapped) {
              rmSync(targetFolder);
              renameSync(targetFolder + '-accepted', targetFolder);
              swapped = false;
            }
            return info;
          };
          syncBuiltinESMExports();
          try {
            let rejected = false;
            if (operation === 'catalog') {
              const loaded = await loadSkills({ cwd: project, harnessHome: join(root, 'home') });
              rejected = loaded.skills.length === 0;
            } else if (operation === 'direct') {
              rejected = await loadSkillFromPath(main, { source: 'project', trustTier: 'trusted' }) === null;
            } else if (operation === 'reload') {
              try { await reloadSkill(baseline); } catch { rejected = true; }
            } else {
              const guard = await guardSkillLoad({ path: main, raw: text('inside'), trustTier: 'community' });
              rejected = guard.action === 'block';
            }
            if (!attempted) throw new Error('filesystem boundary was not reached');
            if (!rejected) throw new Error('outside content was accepted');
            console.log('rejected');
          } finally {
            fs.open = originalOpen;
            fs.stat = originalStat;
            syncBuiltinESMExports();
            rmSync(root, { recursive: true, force: true });
          }
        `,
        operation,
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('rejected');
  });
}
