/** Repeatable public-fixture startup benchmark; no provider/model calls.
 * bun scripts/evals/skill-startup.ts --out PATH
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills } from '../../packages/sdk/src/skills/loader.js';
const argv = process.argv.slice(2);
const output = argv[argv.indexOf('--out') + 1];
if (!argv.includes('--out') || !output) throw new Error('--out PATH required');
const root = await mkdtemp(join(tmpdir(), 'skill-startup-benchmark-'));
const rows: unknown[] = [];
try {
  for (let i = 0; i < 35; i++) {
    const dir = join(root, '.harness/skills', `fixture-${i}`);
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: fixture-${i}\ndescription: Public benchmark fixture\nwhenToUse: When the user requests this example workflow\n---\n${'instruction\n'.repeat(2_000)}`,
    );
    await writeFile(join(dir, 'references/example.md'), 'reference\n'.repeat(1_000));
  }
  for (const mode of ['eager', 'metadata'] as const)
    for (let i = 0; i < 3; i++) {
      await loadSkills({
        cwd: root,
        harnessHome: join(root, 'home'),
        mode,
        onLoadStats: (stats) => rows.push({ mode, run: i + 1, ...stats }),
      });
    }
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        fixture:
          '35 skills, each 24KB body + 10KB reference, three warm filesystem repetitions, excludes provider calls',
        rows,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ output, repetitions: rows.length }));
} finally {
  await rm(root, { recursive: true, force: true });
}
