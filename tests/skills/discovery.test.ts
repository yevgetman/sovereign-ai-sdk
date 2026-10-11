import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type SkillDiscoveryDecision, discoverSkills } from '@yevgetman/sov-sdk/skills/discovery';
import { loadSkills } from '@yevgetman/sov-sdk/skills/loader';

async function fixture(fn: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sov-skill-discovery-')));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function skill(path: string, name: string, description = name): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\nSkill body\n`);
}

function repository(root: string): void {
  mkdirSync(join(root, '.git'), { recursive: true });
}

function link(target: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(target, destination);
}

describe('portable bounded skill discovery', () => {
  test('loads managed node directory projections once from root and subfolders', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      mkdirSync(join(cwd, 'src', 'nested'), { recursive: true });
      const release = join(cwd, 'org-skill', 'sov-sdk-release');
      skill(join(release, 'SKILL.md'), 'sov-sdk-release');
      link(release, join(cwd, '.harness', 'skills', 'sov-sdk-release'));
      link(release, join(cwd, '.agents', 'skills', 'sov-sdk-release'));
      for (const seat of [cwd, join(cwd, 'src', 'nested')]) {
        const registry = await loadSkills({ cwd: seat, harnessHome: join(root, 'home') });
        expect(registry.skills.map((entry) => entry.name)).toEqual(['sov-sdk-release']);
        expect(registry.skills[0]?.source).toBe('project');
        expect(registry.skills[0]?.realpath).toBe(join(release, 'SKILL.md'));
      }
    });
  });

  test('nearest ancestor wins, native wins at equal depth, and project wins over user/plugin/bundle', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const nested = join(cwd, 'src');
      skill(join(cwd, '.harness', 'skills', 'same.md'), 'same', 'parent native');
      skill(join(nested, '.agents', 'skills', 'same.md'), 'same', 'nearest portable');
      skill(join(nested, '.harness', 'skills', 'native.md'), 'native', 'nearest native');
      skill(join(nested, '.agents', 'skills', 'native.md'), 'native', 'nearest portable');
      skill(join(cwd, '.agents', 'skills', 'portable.md'), 'portable');
      const harnessHome = join(root, 'home');
      skill(join(harnessHome, 'skills', 'same.md'), 'same', 'user');
      const plugin = join(root, 'plugin');
      skill(join(plugin, 'same.md'), 'same', 'plugin');
      skill(join(plugin, 'plugin.md'), 'plugin');
      const bundleRoot = join(root, 'bundle');
      skill(join(bundleRoot, 'skills', 'same.md'), 'same', 'bundle');
      skill(join(bundleRoot, 'skills-community', 'community.md'), 'community');
      const decisions: SkillDiscoveryDecision[] = [];
      const registry = await loadSkills({
        cwd: nested,
        harnessHome,
        bundleRoot,
        extraRoots: [{ path: plugin, source: 'plugin', trustTier: 'community' }],
        onDiscoveryDecision: (entry) => decisions.push(entry),
      });
      expect(registry.byName.get('same')?.description).toBe('nearest portable');
      expect(registry.byName.get('native')?.description).toBe('nearest native');
      expect(registry.byName.get('plugin')?.source).toBe('plugin');
      expect(registry.byName.get('community')?.trustTier).toBe('community');
      expect(registry.byName.has('portable')).toBe(true);
      expect(decisions.filter((entry) => entry.code === 'duplicate-name').length).toBe(5);
    });
  });

  test('finds file links, rejects external targets by default, and preserves explicit target classification', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      skill(join(cwd, 'owned', 'file.md'), 'internal');
      const external = join(root, 'another-node');
      skill(join(external, 'SKILL.md'), 'external');
      link(join(cwd, 'owned', 'file.md'), join(cwd, '.agents', 'skills', 'file.md'));
      link(external, join(cwd, '.agents', 'skills', 'external'));
      const decisions: SkillDiscoveryDecision[] = [];
      const baseline = await loadSkills({
        cwd,
        harnessHome: join(root, 'home'),
        onDiscoveryDecision: (entry) => decisions.push(entry),
      });
      expect(baseline.skills.map((entry) => entry.name)).toEqual(['internal']);
      expect(
        decisions.some(
          (entry) => entry.code === 'scope-denied' && entry.path.endsWith('/external'),
        ),
      ).toBe(true);
      const approved = await loadSkills({
        cwd,
        harnessHome: join(root, 'home'),
        allowedLinkRoots: [external],
      });
      expect(approved.byName.get('external')?.source).toBe('project');
      expect(approved.byName.get('external')?.trustTier).toBe('trusted');
    });
  });

  test('stops at nested repo and node boundaries and does not scan unrelated ancestors without a boundary', async () => {
    await fixture(async (root) => {
      repository(root);
      skill(join(root, '.agents', 'skills', 'outer.md'), 'outer');
      const nested = join(root, 'nested');
      repository(nested);
      mkdirSync(join(nested, 'src'), { recursive: true });
      skill(join(nested, '.agents', 'skills', 'nested.md'), 'nested');
      const inside = await loadSkills({
        cwd: join(nested, 'src'),
        projectRoot: root,
        harnessHome: join(root, 'home'),
      });
      expect(inside.skills.map((entry) => entry.name)).toEqual(['nested']);
      const node = join(root, 'node');
      mkdirSync(join(node, '.kernel'), { recursive: true });
      writeFileSync(join(node, '.kernel', 'node.yml'), 'node: local\n');
      mkdirSync(join(node, 'src'), { recursive: true });
      skill(join(node, '.agents', 'skills', 'local.md'), 'local');
      const local = await loadSkills({ cwd: join(node, 'src'), harnessHome: join(root, 'home') });
      expect(local.skills.map((entry) => entry.name)).toEqual(['local']);
      const loose = join(root, 'unmarked');
      // A marker outside the configured boundary cannot affect an explicitly
      // scoped non-repository project.
      skill(join(loose, '.agents', 'skills', 'bounded.md'), 'bounded');
      mkdirSync(join(loose, 'src'), { recursive: true });
      const bounded = await loadSkills({
        cwd: join(loose, 'src'),
        projectRoot: loose,
        harnessHome: join(root, 'home'),
      });
      expect(bounded.skills.map((entry) => entry.name)).toEqual(['bounded']);
      await expect(
        discoverSkills({ cwd: nested, projectRoot: loose, harnessHome: root }),
      ).rejects.toThrow('must contain cwd');
    });
    await fixture(async (root) => {
      skill(join(root, '.agents', 'skills', 'ambient.md'), 'ambient');
      const cwd = join(root, 'unmarked');
      mkdirSync(cwd);
      const registry = await loadSkills({ cwd, harnessHome: join(root, 'home') });
      expect(registry.skills).toEqual([]);
    });
  });

  test('cycles and broken links terminate, and private transaction/VCS/vendor directories are excluded', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const tree = join(cwd, '.harness', 'skills');
      skill(join(tree, 'valid.md'), 'valid');
      link(tree, join(tree, 'cycle'));
      link(join(tree, 'missing'), join(tree, 'broken'));
      for (const directory of [
        '.sov-skill-store',
        '.git',
        '.svn',
        '.hg',
        'node_modules',
        'vendor',
      ]) {
        skill(
          join(tree, directory, 'hidden', 'SKILL.md'),
          `hidden-${directory.replace(/[^a-z]/g, '')}`,
        );
      }
      link(join(tree, '.sov-skill-store'), join(tree, 'transaction-alias'));
      const result = await discoverSkills({ cwd, harnessHome: join(root, 'home') });
      expect(result.candidates.map((entry) => entry.path)).toEqual([join(tree, 'valid.md')]);
      expect(result.decisions.some((entry) => entry.code === 'cycle')).toBe(true);
      expect(result.decisions.some((entry) => entry.code === 'broken-link')).toBe(true);
      expect(
        result.decisions.some(
          (entry) => entry.code === 'scope-denied' && entry.path.endsWith('transaction-alias'),
        ),
      ).toBe(true);
    });
  });

  test('depth, tree count, file count, per-file bytes, and total bytes are bounded and explained', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const tree = join(cwd, '.agents', 'skills');
      skill(join(tree, 'a.md'), 'a');
      skill(join(tree, 'b.md'), 'b');
      skill(join(tree, 'nested', 'deep', 'SKILL.md'), 'deep');
      skill(join(tree, 'large.md'), 'large', 'X'.repeat(2048));
      const size =
        (await discoverSkills({ cwd, harnessHome: root })).candidates.find((entry) =>
          entry.path.endsWith('/a.md'),
        )?.size ?? 0;
      for (const discoveryLimits of [
        { maxDepth: 1 },
        { maxEntries: 2 },
        { maxFiles: 1 },
        { maxFileBytes: 128 },
        { maxTotalBytes: size },
      ]) {
        const result = await discoverSkills({ cwd, harnessHome: root, discoveryLimits });
        expect(result.decisions.some((entry) => entry.code === 'limit')).toBe(true);
      }
      const loaded = await loadSkills({
        cwd,
        harnessHome: root,
        discoveryLimits: { maxFileBytes: 128 },
      });
      expect(loaded.byName.has('large')).toBe(false);
      expect(loaded.byName.has('a')).toBe(true);
      await expect(
        discoverSkills({ cwd, harnessHome: root, discoveryLimits: { maxFiles: -1 } }),
      ).rejects.toThrow('positive safe integer');
    });
  });

  test('rechecks the bounded read after a discovered file grows before loading', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const file = join(cwd, '.harness', 'skills', 'growing.md');
      skill(file, 'growing');
      const decisions: SkillDiscoveryDecision[] = [];
      const registry = await loadSkills({
        cwd,
        harnessHome: join(root, 'home'),
        discoveryLimits: { maxFileBytes: 128 },
        onDiscoveryDecision: (entry) => {
          decisions.push(entry);
          if (entry.code === 'candidate') writeFileSync(file, 'X'.repeat(4096));
        },
      });
      expect(registry.skills).toEqual([]);
      expect(decisions.some((entry) => entry.code === 'load-rejected')).toBe(true);
    });
  });

  test('a linked SKILL.md preserves directory-skill boundaries and does not parse references', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      skill(join(cwd, 'owned', 'definition.md'), 'linked');
      const folder = join(cwd, '.agents', 'skills', 'linked');
      link(join(cwd, 'owned', 'definition.md'), join(folder, 'SKILL.md'));
      skill(join(folder, 'references', 'extra.md'), 'reference');
      const registry = await loadSkills({ cwd, harnessHome: join(root, 'home') });
      expect(registry.skills.map((entry) => entry.name)).toEqual(['linked']);
    });
  });

  test('rejects a discovered regular file replaced by an external link before reading', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const file = join(cwd, '.harness', 'skills', 'changing.md');
      skill(file, 'changing');
      const outside = join(root, 'other-node', 'SKILL.md');
      skill(outside, 'external');
      const registry = await loadSkills({
        cwd,
        harnessHome: join(root, 'home'),
        onDiscoveryDecision: (entry) => {
          if (entry.code === 'candidate') {
            rmSync(file);
            symlinkSync(outside, file);
          }
        },
      });
      expect(registry.skills).toEqual([]);
    });
  });

  test('rejects a discovered file whose parent is replaced by an external directory link', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const folder = join(cwd, '.harness', 'skills', 'changing');
      skill(join(folder, 'SKILL.md'), 'changing');
      const outside = join(root, 'other-node');
      skill(join(outside, 'SKILL.md'), 'external');
      const registry = await loadSkills({
        cwd,
        harnessHome: join(root, 'home'),
        onDiscoveryDecision: (entry) => {
          if (entry.code === 'candidate') {
            rmSync(folder, { recursive: true });
            symlinkSync(outside, folder);
          }
        },
      });
      expect(registry.skills).toEqual([]);
    });
  });

  test('directory resource scans obey shared depth, entry and byte limits and fail closed', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const folder = join(cwd, '.agents', 'skills', 'bounded');
      skill(join(folder, 'SKILL.md'), 'bounded');
      mkdirSync(join(folder, 'references', 'deep'), { recursive: true });
      writeFileSync(join(folder, 'references', 'deep', 'reference.txt'), 'X'.repeat(2048));
      for (const discoveryLimits of [
        { maxFileBytes: 128 },
        { maxEntries: 4 },
        { maxDepth: 1 },
        { maxTotalBytes: 512 },
      ]) {
        const warnings: string[] = [];
        const registry = await loadSkills({
          cwd,
          harnessHome: join(root, 'home'),
          discoveryLimits,
          warn: (message) => warnings.push(message),
        });
        expect(registry.skills).toEqual([]);
        expect(warnings.some((message) => message.includes('resource-limit'))).toBe(true);
      }
    });
  });
});
