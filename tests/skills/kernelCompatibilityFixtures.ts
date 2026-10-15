import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadSkillsOptions } from '@yevgetman/sov-sdk/skills/loader';
import { stringify } from 'yaml';

/** Synthetic producer-style metadata, never copied from an installed skill. */
export const kernelVendorMetadata = {
  future: { nested: ['preserve', { enabled: true }] },
  composition: { executor: 'vendor-only', tools: ['UninstalledTool'] },
};

export function kernelSkillMarkdown(
  name: string,
  fields: Record<string, unknown> = {},
  body = `Guidance for ${name}.`,
): string {
  return `---\n${stringify({
    name,
    description: `Synthetic ${name} workflow`,
    whenToUse: `User asks to run ${name}`,
    context: 'kernel',
    version: 1,
    tier: 'builtin',
    harnesses: ['sov', 'claude'],
    vendor: kernelVendorMetadata,
    ...fields,
  })}---\n${body}\n`;
}

export const kernelCompatibilityFixtures = [
  { name: 'bundled', fields: { kind: 'bundled', version: 1 } },
  { name: 'added', fields: { kind: 'added', version: 'v2' } },
  { name: 'learned', fields: { kind: 'learned', version: 3, confidence: 0.9 } },
  { name: 'ordinary', fields: { context: undefined, version: '1.0' } },
  {
    name: 'compound',
    fields: {
      composition: {
        schema_version: 1,
        members: [
          { id: 'a', source: 'added', name: 'member-a' },
          { id: 'b', source: 'added', name: 'member-b' },
        ],
      },
      requires: ['member-a', 'member-b'],
    },
  },
  { name: 'member-a', fields: { parent: 'compound' } },
  { name: 'member-b', fields: { parent: 'compound' } },
  // Vendor grouping metadata is inert; this does not model a Kernel Skill Set projection.
  { name: 'vendor-group', fields: { kind: 'skill-set', skills: ['compound', 'learned'] } },
  { name: 'manual', fields: { 'disable-model-invocation': true } },
  { name: 'automatic', fields: { 'user-invocable': false } },
];

/** Approved roots and projections live entirely in one disposable test tree. */
export async function createKernelCompatibilityFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sov-kernel-compatibility-'));
  const cwd = join(root, 'node');
  const storage = join(root, 'kernel-skills');
  const projection = join(cwd, '.agents', 'skills');
  await mkdir(projection, { recursive: true });
  await mkdir(join(cwd, '.git'));
  const write = async (name: string, fields: Record<string, unknown> = {}, body?: string) => {
    const dir = join(storage, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), kernelSkillMarkdown(name, fields, body));
    await symlink(dir, join(projection, name));
    return dir;
  };
  for (const fixture of kernelCompatibilityFixtures) await write(fixture.name, fixture.fields);
  const warnings: string[] = [];
  const discovery: LoadSkillsOptions = {
    cwd,
    harnessHome: join(root, 'isolated-home'),
    allowedLinkRoots: [storage],
    warn: (message) => warnings.push(message),
  };
  return {
    root,
    cwd,
    storage,
    projection,
    discovery,
    warnings,
    write,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
