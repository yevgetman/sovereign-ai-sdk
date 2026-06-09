// Plugin consent disclosure (T6) — the pure, I/O-free string builder that
// renders the capability-framed disclosure the operator sees at install time.
//
// Split out of install.ts so the security-critical install orchestration (the
// gates + the consent mint) reads on its own, and so this presentation logic is
// independently testable. Everything here is PURE: it takes the parsed manifest
// + the precomputed component scan and returns a string; it touches no
// filesystem and mutates no input.
//
// Framing contract: every line describes a capability the operator is GRANTING
// or ACKNOWLEDGING — active contributions (skills/commands), declared-but-inert
// blocks (hooks/mcp, never run in v1), ignored CC-only features, bundled
// scripts (disclosed because a Bash-allowed session could be induced to run
// them), guard advisories (⚠), and components disabled by policy (⛔).

import type { PluginManifest } from './manifest.js';

/** A component a guard `block` finding disabled by policy at install time. */
export type GuardedComponent = {
  readonly kind: 'skill' | 'command';
  /** The component's source-relative POSIX path. */
  readonly name: string;
  /** Why it was disabled (e.g. `destructive-operation pattern`). */
  readonly reason: string;
};

/** A non-blocking guard escalation surfaced as an advisory (⚠). */
export type GuardAdvisory = {
  /** The scanned file's source-relative POSIX path. */
  readonly component: string;
  readonly level: 'medium' | 'critical';
  readonly category: string;
};

/** The result of guard-scanning a plugin's prompt-bearing content + detecting
 *  bundled scripts — the disclosure's sole data input besides the manifest. */
export type ComponentScan = {
  /** Total `skills/` components found (a directory-skill = ONE, plus any loose
   *  `.md` skill files), incl. any disabled. Counted per-skill, NOT per-`.md`. */
  readonly skillCount: number;
  /** Total `commands/` components found (incl. any disabled). */
  readonly commandCount: number;
  /** Total prompt-bearing components scanned (skills + commands). */
  readonly totalComponents: number;
  /** Components a guard `block` finding disabled by policy. */
  readonly disabled: GuardedComponent[];
  /** Non-blocking guard escalations on scanned content / bundled scripts. */
  readonly advisories: GuardAdvisory[];
  /** Bundled executable scripts, source-relative (disclosed, never run). */
  readonly scripts: string[];
  /** Bundled non-`.md`, non-script reference files under `skills/`/`commands/`,
   *  source-relative. The operator is consenting to these landing; their guard
   *  relevance (when they sit inside a directory-skill) is already folded into
   *  that skill's aggregated verdict, so they are DISCLOSED, never blocked here. */
  readonly referenceFiles: string[];
};

/**
 * Build the capability-framed consent disclosure string from the parsed
 * manifest + the component scan. Pure — no I/O, no mutation. The active
 * skill/command counts EXCLUDE policy-disabled components (so "Contributes" is
 * honest about what will actually load), and the disabled ones are listed
 * separately under the ⛔ line.
 */
export function buildDisclosure(manifest: PluginManifest, scan: ComponentScan): string {
  const lines: string[] = [];

  const author = manifest.author ? ` by ${manifest.author}` : '';
  lines.push(`Plugin ${manifest.name} v${manifest.version}${author}`);
  if (manifest.description) lines.push(manifest.description);

  const activeSkills = scan.skillCount - countKind(scan.disabled, 'skill');
  const activeCommands = scan.commandCount - countKind(scan.disabled, 'command');
  lines.push(
    `Contributes: ${plural(activeSkills, 'skill')}, ${plural(activeCommands, 'command')}.`,
  );

  const hookCount = countHooks(manifest.hooks);
  const mcpCount = manifest.mcpServers ? Object.keys(manifest.mcpServers).length : 0;
  if (hookCount > 0 || mcpCount > 0) {
    const parts: string[] = [];
    if (hookCount > 0) {
      parts.push(
        `${plural(hookCount, 'hook')} running shell ${describeHookCommands(manifest.hooks)}`,
      );
    }
    if (mcpCount > 0) {
      parts.push(
        `${plural(mcpCount, 'MCP server')} connecting to ${describeMcpHosts(manifest.mcpServers)}`,
      );
    }
    lines.push(`Declares (INERT in v1 — disclosed, never run): ${parts.join('; ')}.`);
  }

  if (manifest.ignored.length > 0) {
    lines.push(`Ignores CC-only feature(s): ${manifest.ignored.join(', ')}.`);
  }

  if (scan.scripts.length > 0) {
    lines.push(
      `Bundles ${plural(scan.scripts.length, 'script')} (NOT run by the harness, but a Bash-allowed session could be induced to run): ${scan.scripts.join(', ')}.`,
    );
  }

  if (scan.referenceFiles.length > 0) {
    lines.push(
      `Bundles ${plural(scan.referenceFiles.length, 'reference file')} (landed alongside skills/commands; a directory-skill's references are folded into its guard verdict): ${scan.referenceFiles.join(', ')}.`,
    );
  }

  for (const advisory of scan.advisories) {
    lines.push(
      `⚠ guard advisory: ${advisory.category} (${advisory.level}) in ${advisory.component}`,
    );
  }

  if (scan.disabled.length > 0) {
    lines.push(
      `⛔ ${scan.disabled.length} of ${scan.totalComponents} component(s) disabled by policy:`,
    );
    for (const d of scan.disabled) {
      lines.push(`   - ${d.name} (${d.reason})`);
    }
  }

  return lines.join('\n');
}

/** Render up to three hook shell commands (with a `+N more` tail). */
function describeHookCommands(hooks: PluginManifest['hooks']): string {
  const commands = collectHookCommands(hooks);
  if (commands.length === 0) return "'(none)'";
  const shown = commands.slice(0, 3).map((c) => `'${c}'`);
  const suffix = commands.length > 3 ? `, +${commands.length - 3} more` : '';
  return `${shown.join(', ')}${suffix}`;
}

/** Every declared hook command across all hook events, in declaration order. */
function collectHookCommands(hooks: PluginManifest['hooks']): string[] {
  if (!hooks) return [];
  const out: string[] = [];
  for (const event of Object.values(hooks)) {
    if (!Array.isArray(event)) continue;
    for (const matcher of event) {
      for (const spec of matcher.hooks) {
        out.push(spec.command);
      }
    }
  }
  return out;
}

/** Distinct hosts each declared MCP server connects to (local command for stdio).
 *  Shared with `/plugins info` so the install consent disclosure and the inspect
 *  surface derive hosts from ONE place (they describe the same declared-inert
 *  servers). Returns `'(none)'` when no servers are declared. */
export function describeMcpHosts(mcpServers: PluginManifest['mcpServers']): string {
  if (!mcpServers) return '(none)';
  const hosts: string[] = [];
  for (const server of Object.values(mcpServers)) {
    if (server.type === 'stdio') {
      hosts.push(`local '${server.command}'`);
    } else {
      hosts.push(hostOf(server.url));
    }
  }
  return [...new Set(hosts)].join(', ');
}

/** Host portion of a URL, or the raw value when it doesn't parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Total declared hook commands across all hook events. Shared with `/plugins
 *  info` so both surfaces count the same declared-inert hooks from ONE place. */
export function countHooks(hooks: PluginManifest['hooks']): number {
  return collectHookCommands(hooks).length;
}

function countKind(disabled: GuardedComponent[], kind: 'skill' | 'command'): number {
  return disabled.filter((d) => d.kind === kind).length;
}

/** `"1 skill"` / `"2 skills"` — count + correctly pluralized noun. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
