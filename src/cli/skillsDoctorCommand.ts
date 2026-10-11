// Local diagnostics only. The server uses remoteSkillDiagnostics() instead.
import { getDefaultBundlePath } from '@yevgetman/sov-sdk/bundle/defaultBundle';
import { resolveHarnessHome } from '@yevgetman/sov-sdk/config/paths';
import { readConfig } from '@yevgetman/sov-sdk/config/store';
import { createSkillRegistryManager, loadSkillRegistry } from '@yevgetman/sov-sdk/skills/registry';
import { loadPluginRuntime } from '../plugins/runtime.js';

export async function runSkillsDoctor(
  opts: {
    cwd?: string;
    harnessHome?: string;
    bundleRoot?: string;
    allowedLinkRoots?: string[];
    json?: boolean;
  },
  write: (text: string) => void = (text) => process.stdout.write(`${text}\n`),
): Promise<number> {
  const harnessHome = opts.harnessHome ?? resolveHarnessHome();
  const settings = readConfig({ harnessHome });
  const { contributions } = await loadPluginRuntime({
    harnessHome,
    config: settings.plugins ?? {},
  });
  const approvedRoots = opts.allowedLinkRoots ?? settings.skills?.discovery?.allowedLinkRoots;
  const projectRoot = settings.skills?.discovery?.projectRoot;
  const bundleRoot = opts.bundleRoot ?? getDefaultBundlePath();
  const manager = createSkillRegistryManager({
    load: () =>
      loadSkillRegistry({
        cwd: opts.cwd ?? process.cwd(),
        harnessHome,
        ...(bundleRoot !== null ? { bundleRoot } : {}),
        ...(projectRoot !== undefined ? { projectRoot } : {}),
        ...(approvedRoots !== undefined ? { allowedLinkRoots: approvedRoots } : {}),
        extraRoots: contributions.skillRoots,
      }),
  });
  const snapshot = await manager.refresh();
  const report = {
    generation: snapshot.generation,
    skillCount: snapshot.registry.skills.length,
    diagnostics: snapshot.diagnostics,
  };
  if (opts.json) write(JSON.stringify(report, null, 2));
  else {
    const roots = report.diagnostics.filter(
      (item) => item.code === 'root-ready' || item.code === 'root-missing',
    );
    const counts = new Map<string, number>();
    for (const item of report.diagnostics) counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
    write(
      [
        `skill generation ${report.generation}: ${report.skillCount} loaded`,
        ...roots.map((item) => `${item.code}: ${item.path}`),
        ...[...counts].map(([code, count]) => `${code}: ${count}`),
      ].join('\n'),
    );
  }
  return 0;
}
