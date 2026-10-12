import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSkillsDoctor } from '../../src/cli/skillsDoctorCommand.js';

test('doctor resolves the default bundle within its explicitly selected profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-doctor-profile-'));
  const originalHome = process.env.HARNESS_HOME;
  try {
    const active = join(root, 'active');
    const selected = join(root, 'selected');
    const cwd = join(root, 'project');
    await mkdir(cwd, { recursive: true });
    for (const [home, name] of [
      [active, 'activeProfile'],
      [selected, 'selectedProfile'],
    ] as const) {
      const bundle = join(home, 'default-bundle');
      await mkdir(join(bundle, 'skills'), { recursive: true });
      await writeFile(join(bundle, 'index.yaml'), 'documents: []\n');
      await writeFile(
        join(bundle, 'skills', `${name}.md`),
        `---\nname: ${name}\ndescription: Profile-specific guidance\n---\nSafe instructions.\n`,
      );
    }
    process.env.HARNESS_HOME = active;
    const output: string[] = [];
    expect(
      await runSkillsDoctor({ cwd, harnessHome: selected, json: true }, (text) =>
        output.push(text),
      ),
    ).toBe(0);
    const report = JSON.parse(output.join('\n')) as {
      diagnostics: { name?: string; path?: string }[];
    };
    expect(report.diagnostics.some((item) => item.name === 'selectedProfile')).toBe(true);
    expect(report.diagnostics.some((item) => item.name === 'activeProfile')).toBe(false);
    expect(
      report.diagnostics.some((item) => item.path?.startsWith(join(active, 'default-bundle'))),
    ).toBe(false);
    const explicit: string[] = [];
    await runSkillsDoctor(
      { cwd, harnessHome: selected, bundleRoot: join(active, 'default-bundle'), json: true },
      (text) => explicit.push(text),
    );
    expect(
      JSON.parse(explicit.join('\n')).diagnostics.some(
        (item: { name?: string }) => item.name === 'activeProfile',
      ),
    ).toBe(true);
  } finally {
    // biome-ignore lint/performance/noDelete: environment keys must be removed to restore absence.
    if (originalHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  }
});
