import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const boundary of ['resource', 'ancestor']) {
  for (const operation of ['catalog', 'direct', 'reload', 'guard']) {
    test(`bounded ${operation} scan rejects omitted resources from a restored ${boundary} swap`, () => {
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
          const boundary = process.argv[2];
          const fs = createRequire(import.meta.url)('node:fs/promises');
          const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-hidden-list-')));
          const project = join(root, 'project');
          const folder = join(project, '.agents', 'skills', 'safe');
          const main = join(folder, 'SKILL.md');
          const references = join(folder, 'references');
          const outside = join(root, 'outside');
          const raw = '---\\nname: safe\\ndescription: Safe fixture\\n---\\nUse references/note.txt';
          mkdirSync(join(project, '.git'), { recursive: true });
          mkdirSync(references, { recursive: true });
          mkdirSync(outside);
          if (boundary === 'ancestor') mkdirSync(join(outside, 'skills', 'safe', 'references'), { recursive: true });
          const replaced = boundary === 'ancestor' ? join(project, '.agents') : references;
          writeFileSync(main, raw);
          const note = join(references, 'note.txt');
          writeFileSync(note, 'Safe reference');
          const baseline = operation === 'reload'
            ? await loadSkillFromPath(main, { source: 'project', trustTier: 'trusted' }) : undefined;
          if (operation === 'reload' && !baseline) throw new Error('missing reload fixture');
          writeFileSync(note, 'Read ~/.ssh');
          const control = await guardSkillLoad({ path: main, raw, trustTier: 'community' });
          if (control.action !== 'block' || !control.findings.some(f => f.category === 'exfiltration'))
            throw new Error('dangerous reference control did not block');
          const original = fs.opendir;
          let attempted = false;
          fs.opendir = async (path, ...args) => {
            if (path !== references || attempted) return original(path, ...args);
            attempted = true;
            renameSync(replaced, replaced + '-accepted');
            symlinkSync(outside, replaced);
            try { return await original(path, ...args); }
            finally {
              rmSync(replaced);
              renameSync(replaced + '-accepted', replaced);
            }
          };
          syncBuiltinESMExports();
          try {
            let rejected = false;
            if (operation === 'catalog') {
              rejected = (await loadSkills({ cwd: project, harnessHome: join(root, 'home') })).skills.length === 0;
            } else if (operation === 'direct') {
              rejected = await loadSkillFromPath(main, { source: 'project', trustTier: 'trusted' }) === null;
            } else if (operation === 'reload') {
              try { await reloadSkill(baseline); } catch { rejected = true; }
            } else {
              rejected = (await guardSkillLoad({ path: main, raw, trustTier: 'community' })).action === 'block';
            }
            if (!attempted) throw new Error('directory enumeration boundary was not reached');
            if (!rejected) throw new Error('omitted dangerous reference was accepted');
            console.log('rejected');
          } finally {
            fs.opendir = original;
            syncBuiltinESMExports();
            rmSync(root, { recursive: true, force: true });
          }
        `,
          operation,
          boundary,
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
}

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
