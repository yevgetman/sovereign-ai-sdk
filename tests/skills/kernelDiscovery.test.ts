import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills } from '@yevgetman/sov-sdk/skills/discovery';
import { loadSkills, reloadSkill } from '@yevgetman/sov-sdk/skills/loader';
import { loadSkillRegistry, remoteSkillDiagnostics } from '@yevgetman/sov-sdk/skills/registry';
import { runSkillsDoctor } from '../../src/cli/skillsDoctorCommand.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(fileLink = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kernel-linked-skills-')));
  roots.push(root);
  const cwd = join(root, 'node');
  const storage = join(root, 'added-skill', 'safe');
  const replacement = join(root, 'added-skill', 'safe-sibling');
  const harnessHome = join(root, 'profile');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  for (const target of [storage, replacement]) {
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'SKILL.md'),
      '---\nname: linked-safe\ndescription: Use when checking a synthetic linked fixture\nwhenToUse: Use when checking a synthetic linked fixture\n---\nPRIVATE_BODY_SENTINEL\n',
    );
  }
  for (const host of ['.harness', '.agents'])
    mkdirSync(join(cwd, host, 'skills'), { recursive: true });
  const link = join(cwd, '.harness', 'skills', fileLink ? 'linked.md' : 'linked');
  const alias = join(cwd, '.agents', 'skills', fileLink ? 'linked.md' : 'linked');
  const target = fileLink ? join(storage, 'SKILL.md') : storage;
  symlinkSync(target, link);
  symlinkSync(target, alias);
  return { root, cwd, storage, replacement, harnessHome, link, alias, target };
}

for (const fileLink of [false, true]) {
  test(`doctor explains ${fileLink ? 'file' : 'directory'} approval once without private contents`, async () => {
    const f = fixture(fileLink);
    const output: string[] = [];
    await runSkillsDoctor(
      {
        cwd: f.cwd,
        harnessHome: f.harnessHome,
        bundleRoot: join(f.root, 'empty-bundle'),
        json: true,
      },
      (value) => output.push(value),
    );
    const report = JSON.parse(output.join('\n'));
    const blocked = report.diagnostics.filter((d: { code: string }) => d.code === 'scope-denied');
    expect(report.skillCount).toBe(0);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      path: f.link,
      realpath: f.target,
      approval: { settingsField: 'skills.discovery.allowedLinkRoots', canonicalRoot: f.target },
      aliases: [f.alias],
    });
    expect(report.diagnostics.some((d: { code: string }) => d.code === 'loader-warning')).toBe(
      false,
    );
    expect(output.join('\n')).not.toContain('PRIVATE_BODY_SENTINEL');
    expect(output.join('\n')).not.toContain(f.replacement);
    const snapshot = await loadSkillRegistry({ cwd: f.cwd, harnessHome: f.harnessHome });
    const remote = JSON.stringify(
      remoteSkillDiagnostics({
        generation: 1,
        ...snapshot,
        diagnostics: snapshot.diagnostics ?? [],
      }),
    );
    expect(remote).not.toContain(f.root);
    expect(remote).not.toContain('canonicalRoot');
    expect(remote).not.toContain('PRIVATE_BODY_SENTINEL');
  });

  test(`exact approved ${fileLink ? 'file' : 'directory'} root loads once, siblings stay blocked`, async () => {
    const f = fixture(fileLink);
    const opts = {
      cwd: f.cwd,
      harnessHome: f.harnessHome,
      bundleRoot: join(f.root, 'empty-bundle'),
    };
    expect((await loadSkills(opts)).skills).toHaveLength(0);
    const registry = await loadSkills({ ...opts, allowedLinkRoots: [f.target] });
    expect(registry.skills.map((s) => s.name)).toEqual(['linked-safe']);
    expect(registry.skills[0]).toMatchObject({ source: 'project', trustTier: 'trusted' });
    const siblingLink = join(f.cwd, '.harness', 'skills', 'sibling');
    symlinkSync(f.replacement, siblingLink);
    const discovery = await discoverSkills({ ...opts, allowedLinkRoots: [f.target] });
    expect(discovery.candidates).toHaveLength(1);
    expect(
      discovery.decisions.some((d) => d.path === siblingLink && d.code === 'scope-denied'),
    ).toBe(true);
    const output: string[] = [];
    await runSkillsDoctor(
      {
        ...opts,
        allowedLinkRoots: [f.target],
        bundleRoot: join(f.root, 'empty-bundle'),
        json: true,
      },
      (value) => output.push(value),
    );
    const report = JSON.parse(output.join('\n'));
    expect(report.skillCount).toBe(1);
    expect(report.diagnostics.some((d: { code: string }) => d.code === 'duplicate-realpath')).toBe(
      false,
    );
  });

  test(`discovery rejects a ${fileLink ? 'file' : 'directory'} link retargeted before loading`, async () => {
    const f = fixture(fileLink);
    let swapped = false;
    const registry = await loadSkills({
      cwd: f.cwd,
      harnessHome: f.harnessHome,
      allowedLinkRoots: [f.storage, f.replacement],
      onDiscoveryDecision(d) {
        if (d.code !== 'candidate' || d.path.indexOf('.harness') < 0) return;
        swapped = true;
        rmSync(f.link);
        symlinkSync(fileLink ? join(f.replacement, 'SKILL.md') : f.replacement, f.link);
        // Keep the second projection from providing a fresh, valid candidate.
        rmSync(f.alias);
      },
    });
    expect(swapped).toBe(true);
    expect(registry.skills).toHaveLength(0);
  });

  test(`reload rejects an approved ${fileLink ? 'file' : 'directory'} link retargeted after loading`, async () => {
    const f = fixture(fileLink);
    const registry = await loadSkills({
      cwd: f.cwd,
      harnessHome: f.harnessHome,
      allowedLinkRoots: [f.storage, f.replacement],
    });
    const loaded = registry.skills[0];
    if (!loaded) throw new Error('fixture missing');
    rmSync(f.link);
    symlinkSync(fileLink ? join(f.replacement, 'SKILL.md') : f.replacement, f.link);
    await expect(reloadSkill(loaded)).rejects.toThrow('changed its resolved path');
  });
}

test('excluded internal and vendor trees never receive a misleading approval hint', async () => {
  const f = fixture();
  for (const excluded of ['.sov-skill-stage-private', '.git', 'node_modules']) {
    const target = join(f.root, excluded, 'hidden');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(f.cwd, '.harness', 'skills', excluded.slice(1)));
  }
  const result = await discoverSkills({ cwd: f.cwd, harnessHome: f.harnessHome });
  const excluded = result.decisions.filter((d) => d.realpath?.includes('/hidden'));
  expect(excluded).toHaveLength(3);
  expect(excluded.every((d) => !('approval' in d))).toBe(true);
});

test('doctor bounds repeated aliases and keeps different targets and name conflicts separate', async () => {
  const f = fixture();
  for (let index = 0; index < 24; index++)
    symlinkSync(f.storage, join(f.cwd, '.agents', 'skills', `alias-${index}`));
  symlinkSync(f.replacement, join(f.cwd, '.agents', 'skills', 'other-target'));
  const output: string[] = [];
  const opts = {
    cwd: f.cwd,
    harnessHome: f.harnessHome,
    bundleRoot: join(f.root, 'empty-bundle'),
    json: true,
  };
  await runSkillsDoctor(opts, (value) => output.push(value));
  const report = JSON.parse(output.join('\n'));
  const denied = report.diagnostics.filter((d: { code: string }) => d.code === 'scope-denied');
  expect(denied).toHaveLength(2);
  const shared = denied.find((d: { realpath: string }) => d.realpath === f.storage);
  expect(shared.path).toBe(f.link);
  expect(shared.aliases).toHaveLength(16);
  output.length = 0;
  await runSkillsDoctor({ ...opts, allowedLinkRoots: [f.storage, f.replacement] }, (value) =>
    output.push(value),
  );
  const approved = JSON.parse(output.join('\n'));
  expect(approved.skillCount).toBe(1);
  expect(
    approved.diagnostics.filter((d: { code: string }) => d.code === 'duplicate-name'),
  ).toHaveLength(1);
  expect(approved.diagnostics.some((d: { code: string }) => d.code === 'duplicate-realpath')).toBe(
    false,
  );
});
