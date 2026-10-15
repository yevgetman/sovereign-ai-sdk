// Local diagnostics only. The server uses remoteSkillDiagnostics() instead.
import { getDefaultBundlePath } from '@yevgetman/sov-sdk/bundle/defaultBundle';
import { resolveHarnessHome } from '@yevgetman/sov-sdk/config/paths';
import { readConfig } from '@yevgetman/sov-sdk/config/store';
import { createSkillRegistryManager, loadSkillRegistry } from '@yevgetman/sov-sdk/skills/registry';
import type { SkillRegistryDiagnostic } from '@yevgetman/sov-sdk/skills/registry';
import { loadPluginRuntime } from '../plugins/runtime.js';

type LocalDiagnostic = SkillRegistryDiagnostic & { aliases?: string[] };

/** Presentation only: keep discovery order and all distinct failure decisions. */
function localDiagnostics(diagnostics: readonly SkillRegistryDiagnostic[]): LocalDiagnostic[] {
  const structuredWarnings = new Set(
    diagnostics
      .filter((item) => item.path !== undefined && item.code !== 'loader-warning')
      .map((item) => `skill skipped (${item.path}): ${item.message}`),
  );
  const externalLinks = new Map<string, LocalDiagnostic>();
  const result: LocalDiagnostic[] = [];
  for (const item of diagnostics) {
    // Canonical deduplication already kept the winner; this is routine scan
    // bookkeeping, not a separate warning or a second loaded skill.
    if (item.code === 'duplicate-realpath') continue;
    if (item.code === 'loader-warning' && structuredWarnings.has(item.message)) continue;
    const diagnostic: LocalDiagnostic = { ...item };
    if (item.code === 'scope-denied' && item.approval && item.realpath && item.path) {
      const key = JSON.stringify([
        item.realpath,
        item.source,
        item.trustTier,
        item.message,
        item.approval,
      ]);
      const previous = externalLinks.get(key);
      if (previous) {
        // Keep alias reporting bounded; traversal limits still apply upstream.
        if (
          item.path !== previous.path &&
          !previous.aliases?.includes(item.path) &&
          (previous.aliases?.length ?? 0) < 16
        ) {
          previous.aliases ??= [];
          previous.aliases.push(item.path);
        }
        continue;
      }
      externalLinks.set(key, diagnostic);
    }
    result.push(diagnostic);
  }
  return result;
}

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
  const bundleRoot = opts.bundleRoot ?? getDefaultBundlePath({ harnessHome });
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
    diagnostics: localDiagnostics(snapshot.diagnostics),
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
