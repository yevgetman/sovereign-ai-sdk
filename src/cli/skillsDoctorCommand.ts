import { dirname } from 'node:path';
// Local diagnostics only. The server uses remoteSkillDiagnostics() instead.
import { getDefaultBundlePath } from '@yevgetman/sov-sdk/bundle/defaultBundle';
import { resolveHarnessHome } from '@yevgetman/sov-sdk/config/paths';
import {
  ConfigurationError,
  loadRuntimeSettingsSnapshot,
} from '@yevgetman/sov-sdk/config/settings';
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
    skillApprovalFile?: string;
  },
  write: (text: string) => void = (text) => process.stdout.write(`${text}\n`),
): Promise<number> {
  const harnessHome = opts.harnessHome ?? resolveHarnessHome();
  let configSnapshot: ReturnType<typeof loadRuntimeSettingsSnapshot>;
  try {
    configSnapshot = loadRuntimeSettingsSnapshot({
      cwd: opts.cwd ?? process.cwd(),
      harnessHome,
      ...(opts.skillApprovalFile !== undefined
        ? { skillApprovalFile: opts.skillApprovalFile }
        : {}),
      ...(opts.allowedLinkRoots !== undefined
        ? { skillDiscovery: { allowedLinkRoots: opts.allowedLinkRoots } }
        : {}),
    });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    const report = {
      skillSettings: { schemaVersion: 1, valid: false, source: error.source },
      skills: [],
      error: { code: error.code, message: error.message },
    };
    write(opts.json ? JSON.stringify(report) : error.message);
    return 1;
  }
  const settings = configSnapshot.config;
  const { contributions } = await loadPluginRuntime({
    harnessHome,
    config: settings.plugins ?? {},
  });
  const approvedRoots = configSnapshot.discovery.allowedLinkRoots;
  const projectRoot = configSnapshot.discovery.projectRoot;
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
    skillSettings: configSnapshot.skillSettings,
    skills: snapshot.registry.skills.map((skill) => ({
      name: skill.name,
      root: dirname(skill.realpath),
    })),
    generation: snapshot.generation,
    skillCount: snapshot.registry.skills.length,
    diagnostics: localDiagnostics([
      ...snapshot.diagnostics,
      ...configSnapshot.unavailableApprovalRoots.map((path) => ({
        code: 'unreadable' as const,
        path,
        message: 'approved link root is unavailable',
      })),
    ]),
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
