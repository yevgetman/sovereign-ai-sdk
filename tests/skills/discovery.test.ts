import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type SkillDiscoveryDecision, discoverSkills } from '@yevgetman/sov-sdk/skills/discovery';
import { loadSkills, reloadSkill } from '@yevgetman/sov-sdk/skills/loader';

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
  test('resource guard scans exclude private stage and backup trees', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      const home = join(root, 'home');
      repository(cwd);
      const folder = join(home, 'skills', 'safe');
      skill(join(folder, 'SKILL.md'), 'safe');
      for (const internal of [
        '.sov-skill-store',
        '.sov-skill-stage-1234',
        '.SOV-SKILL-BACKUP-5678',
      ]) {
        mkdirSync(join(folder, internal));
        writeFileSync(join(folder, internal, 'interrupted.txt'), 'rm -rf /');
      }
      expect((await loadSkills({ cwd, harnessHome: home })).byName.has('safe')).toBe(true);
    });
  });
  test('throwing and rejecting diagnostic observers cannot reject catalogs or terminate Node', () => {
    const result = spawnSync(
      'node',
      [
        '--unhandled-rejections=strict',
        '--input-type=module',
        '-e',
        `
          import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
          import { tmpdir } from 'node:os';
          import { join } from 'node:path';
          import { discoverSkills } from '@yevgetman/sov-sdk/skills/discovery';
          import { loadSkills } from '@yevgetman/sov-sdk/skills/loader';
          const root = await mkdtemp(join(tmpdir(), 'skill-discovery-observers-'));
          try {
            const dir = join(root, '.agents/skills');
            await mkdir(dir, { recursive: true });
            const document = '---\\nname: safe\\ndescription: Public fixture\\n---\\nSafe guidance.';
            await writeFile(join(dir, 'a.md'), document);
            await writeFile(join(dir, 'duplicate.md'), document);
            await writeFile(join(dir, 'malformed.md'), 'Malformed fixture');
            for (const asynchronous of [false, true]) {
              const decisions = new Set();
              let warnings = 0;
              const fail = () => {
                if (asynchronous) return Promise.reject(new Error('diagnostic rejected'));
                throw new Error('diagnostic threw');
              };
              const options = {
                cwd: root, harnessHome: join(root, 'home'),
                onDiscoveryDecision: decision => { decisions.add(decision.code); return fail(); },
                warn: () => { warnings++; return fail(); },
              };
              if ((await discoverSkills(options)).candidates.length !== 3)
                throw new Error('observer changed discovery');
              const loaded = await loadSkills(options);
              if (loaded.skills.length !== 1 || !loaded.byName.has('safe'))
                throw new Error('observer changed catalog');
              if (!decisions.has('load-rejected') || !decisions.has('duplicate-name') || !warnings)
                throw new Error('observer delivery was lost');
            }
            await new Promise(resolve => setTimeout(resolve, 10));
            console.log('loaded');
          } finally { await rm(root, { recursive: true, force: true }); }
        `,
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('loaded');
  });

  test('reload pins a discovered canonical directory instead of accepting a later link swap', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const folder = join(cwd, '.agents', 'skills', 'safe');
      skill(join(folder, 'SKILL.md'), 'safe');
      const loaded = (await loadSkills({ cwd, harnessHome: join(root, 'home') })).byName.get(
        'safe',
      );
      if (!loaded) throw new Error('fixture missing');
      const outside = join(root, 'outside');
      skill(join(outside, 'SKILL.md'), 'safe', 'Replacement outside the approved root');
      renameSync(folder, `${folder}-old`);
      symlinkSync(outside, folder);
      await expect(reloadSkill(loaded)).rejects.toThrow('changed its resolved path');
    });
  });
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

  test('an unreadable node marker never inherits an enclosing repository catalog', async () => {
    await fixture(async (root) => {
      repository(root);
      skill(join(root, '.agents', 'skills', 'outer.md'), 'outer');
      const node = join(root, 'node');
      const markerDirectory = join(node, '.kernel');
      skill(join(node, '.agents', 'skills', 'local.md'), 'local');
      mkdirSync(join(node, 'src'), { recursive: true });
      mkdirSync(markerDirectory);
      writeFileSync(join(markerDirectory, 'node.yml'), 'node: local\n');
      chmodSync(markerDirectory, 0);
      try {
        for (const cwd of [node, join(node, 'src')]) {
          const decisions: SkillDiscoveryDecision[] = [];
          const registry = await loadSkills({
            cwd,
            harnessHome: join(root, 'home'),
            projectRoot: root,
            onDiscoveryDecision: (decision) => decisions.push(decision),
          });
          expect(registry.skills.map((entry) => entry.name)).toEqual(['local']);
          expect(
            decisions.some(
              (entry) =>
                entry.code === 'unreadable' && entry.path === join(markerDirectory, 'node.yml'),
            ),
          ).toBe(true);
        }
      } finally {
        chmodSync(markerDirectory, 0o700);
      }
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
        '.sov-skill-stage-1234',
        '.SOV-SKILL-BACKUP-5678',
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
      link(join(tree, '.sov-skill-stage-1234'), join(tree, 'stage-alias'));
      link(join(tree, '.SOV-SKILL-BACKUP-5678'), join(tree, 'backup-alias'));
      const result = await discoverSkills({ cwd, harnessHome: join(root, 'home') });
      expect(result.candidates.map((entry) => entry.path)).toEqual([join(tree, 'valid.md')]);
      expect(result.decisions.some((entry) => entry.code === 'cycle')).toBe(true);
      expect(result.decisions.some((entry) => entry.code === 'broken-link')).toBe(true);
      expect(
        result.decisions.some(
          (entry) => entry.code === 'scope-denied' && entry.path.endsWith('transaction-alias'),
        ),
      ).toBe(true);
      expect(
        result.decisions.some(
          (entry) => entry.code === 'scope-denied' && entry.path.endsWith('stage-alias'),
        ),
      ).toBe(true);
      expect(
        result.decisions.some(
          (entry) => entry.code === 'scope-denied' && entry.path.endsWith('backup-alias'),
        ),
      ).toBe(true);
    });
  });

  test('canonical exclusions stop aliases while explicit approved package roots remain eligible', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const tree = join(cwd, '.agents', 'skills');
      for (const directory of ['.git', '.svn', '.hg', 'node_modules', 'vendor']) {
        const name = `hidden-${directory.replace(/[^a-z]/g, '')}`;
        const target = join(tree, directory, 'package');
        skill(join(target, 'SKILL.md'), name);
        link(target, join(tree, `alias-${name}`));
      }
      const denied = await loadSkills({ cwd, harnessHome: join(root, 'home') });
      expect(denied.skills).toEqual([]);
      const packageRoot = join(tree, 'node_modules', 'package');
      const approved = await loadSkills({
        cwd,
        harnessHome: join(root, 'home'),
        allowedLinkRoots: [packageRoot],
      });
      expect(approved.skills.map((entry) => entry.name)).toEqual(['hidden-nodemodules']);
      const explicit = await loadSkills({
        cwd,
        harnessHome: join(root, 'home'),
        extraRoots: [{ path: packageRoot, source: 'plugin', trustTier: 'community' }],
      });
      expect(explicit.byName.get('hidden-nodemodules')?.source).toBe('plugin');
      expect(explicit.byName.get('hidden-nodemodules')?.trustTier).toBe('community');
    });
  });

  test('explicit package roots retain approval with an enclosing pluginRoot without approving excluded descendants', async () => {
    await fixture(async (root) => {
      const cwd = join(root, 'project');
      repository(cwd);
      const pluginRoot = join(root, 'plugin');
      for (const directory of ['node_modules', 'vendor']) {
        const packageRoot = join(pluginRoot, directory, 'dependency', 'skills');
        const name = `explicit-${directory.replace(/[^a-z]/g, '')}`;
        skill(join(packageRoot, 'safe.md'), name);
        const nested = join(packageRoot, 'node_modules', 'nested');
        skill(join(nested, 'SKILL.md'), 'implicit-nested');
        link(nested, join(packageRoot, 'nested-alias'));
        const transaction = join(packageRoot, '.sov-skill-store', 'transaction');
        skill(join(transaction, 'SKILL.md'), 'private-transaction');
        link(transaction, join(packageRoot, 'transaction-alias'));
        const result = await loadSkills({
          cwd,
          harnessHome: join(root, 'home'),
          extraRoots: [{ path: packageRoot, pluginRoot, source: 'plugin', trustTier: 'community' }],
        });
        expect(result.skills.map((entry) => entry.name)).toEqual([name]);
        expect(result.byName.get(name)?.source).toBe('plugin');
        expect(result.byName.get(name)?.trustTier).toBe('community');
        expect(result.byName.get(name)?.pluginRoot).toBe(pluginRoot);
      }
      const approvedExternal = join(root, 'approved-external');
      for (const directory of ['node_modules', 'vendor']) {
        const packageRoot = join(approvedExternal, directory, 'dependency', 'skills');
        const name = `external-${directory.replace(/[^a-z]/g, '')}`;
        skill(join(packageRoot, 'safe.md'), name);
        const nested = join(packageRoot, 'vendor', 'nested');
        skill(join(nested, 'SKILL.md'), 'implicit-external-nested');
        link(nested, join(packageRoot, 'nested-alias'));
        const result = await loadSkills({
          cwd,
          harnessHome: join(root, 'home'),
          allowedLinkRoots: [approvedExternal],
          extraRoots: [{ path: packageRoot, pluginRoot, source: 'plugin', trustTier: 'community' }],
        });
        expect(result.skills.map((entry) => entry.name)).toEqual([name]);
        expect(result.byName.get(name)?.source).toBe('plugin');
        expect(result.byName.get(name)?.trustTier).toBe('community');
        expect(result.byName.get(name)?.pluginRoot).toBe(pluginRoot);
      }
      const outside = join(root, 'outside');
      skill(join(outside, 'safe.md'), 'outside');
      const denied = await loadSkills({
        cwd,
        harnessHome: join(root, 'home'),
        allowedLinkRoots: [approvedExternal],
        extraRoots: [{ path: outside, pluginRoot, source: 'plugin', trustTier: 'community' }],
      });
      expect(denied.skills).toEqual([]);
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
