// Plugin install/uninstall (T6) — the TTY disclose-and-consent flow that is the
// ONLY legitimate caller of `writeConsent`. Mirrors the discriminated-result +
// path-containment patterns of `src/skills/install.ts`, hardened for the plugin
// threat model: a hostile package must be rejected or flagged UP FRONT, before
// the operator is ever asked to consent.
//
// `installPlugin` runs every safety gate BEFORE calling the injected `confirm`
// (so a baked-secret / path-escaping / symlink-escaping / guard-blocked package
// never reaches the consent prompt as if it were clean), then — only on accept
// — copies the tree, hashes the COPIED tree, and mints the consent record. The
// hash is computed on what actually landed, so the T3 loader's `verifyConsent`
// will accept the install (and reject any post-consent tamper).
//
// `confirm` is INJECTED: a real TTY yes/no prompt in production wiring (T7/T8),
// a stub in tests. Neither function ever throws — every failure is a
// discriminated error result.

import { type Dirent, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { guardSkillLoad, guardSkillText } from '../skills/guard.js';
import { assertNoSymlinkEscape, copySkillTree } from '../skills/symlinkGuard.js';
import { buildConsentRecord, writeConsent } from './consent.js';
import {
  type ComponentScan,
  type GuardAdvisory,
  type GuardedComponent,
  buildDisclosure,
} from './disclosure.js';
import { hashPluginTree } from './integrity.js';
import { type PluginManifest, parsePluginManifest } from './manifest.js';
import { isOneLevelUnder, isWithin } from './pathContainment.js';
import { scanObjectForSecrets } from './secretScan.js';

/** Per-component consent recorded at mint time: skills + commands are ACCEPTED;
 *  hooks + mcpServers are ACKNOWLEDGED-as-inert (declared, never run in v1). */
const PLUGIN_CONSENT_DECISIONS = {
  skills: true,
  commands: true,
  hooks: false,
  mcpServers: false,
} as const;

/** A plugin name must be a lowercase hyphen-separated slug — the install-dir
 *  segment and the uninstall path-traversal guard. Mirrors the manifest regex. */
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** File extensions that mark a bundled executable script. Such a file is
 *  DISCLOSED (a Bash-allowed operator could be induced to run it), never run or
 *  blocked here. */
const SCRIPT_EXTENSIONS = ['.sh', '.py', '.js', '.ts', '.rb', '.pl'] as const;

/** The `${CLAUDE_PLUGIN_ROOT}` token a manifest uses to reference its own
 *  install root; resolved against the source root for containment checks. */
const PLUGIN_ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';

export interface InstallPluginOptions {
  /** Source dir containing `.claude-plugin/plugin.json`. */
  source: string;
  /** The `<harnessHome>/plugins/` root the plugin lands under (`<root>/<name>/`). */
  pluginsRoot: string;
  /** Injected disclose-and-consent prompt. Returns true to install. */
  confirm: (disclosure: string) => Promise<boolean>;
  /** Optional diagnostics sink (no `console.log` in this module). */
  warn?: (message: string) => void;
  /** ISO-8601 timestamp stamped into the consent record. Defaults to now. */
  now?: string;
  /** When true, overwrite an existing install with the same name. */
  force?: boolean;
}

export interface InstallPluginSuccess {
  ok: true;
  name: string;
  installedAt: string;
  skillCount: number;
  commandCount: number;
}

export interface InstallPluginError {
  ok: false;
  reason: string;
}

export interface InstallPluginDeclined {
  ok: false;
  declined: true;
}

export type InstallPluginResult = InstallPluginSuccess | InstallPluginError | InstallPluginDeclined;

/**
 * Install a plugin from a local source dir under TTY disclose-and-consent.
 *
 * Gate order (EVERY reject below fires BEFORE `confirm`):
 *   1. resolve source (dir + `.claude-plugin/plugin.json`)
 *   2. validate manifest (`parsePluginManifest`)
 *   3. secret-scan the manifest surface (hooks + mcpServers) — REJECT on a literal
 *   4. M1 path containment — REJECT absolute / `../`-escaping declared paths
 *   5. symlink-escape (`assertNoSymlinkEscape`) — REJECT out-of-tree/dangling links
 *   6. refuse-overwrite (unless `force`) — never ask to consent to a refusal
 *   7. guard-scan prompt content (+ detect bundled scripts) — `block` ⇒ disabled-by-policy
 *   8. build the capability-framed disclosure
 *   9. `confirm(disclosure)` — decline ⇒ nothing lands
 *  10. on accept: copy tree → hash COPIED tree → mint + write consent
 */
export async function installPlugin(opts: InstallPluginOptions): Promise<InstallPluginResult> {
  // 1. Resolve source.
  const sourceAbs = resolve(opts.source);
  const manifestPath = join(sourceAbs, '.claude-plugin', 'plugin.json');
  if (!existsSync(sourceAbs) || !existsSync(manifestPath)) {
    return { ok: false, reason: `not a plugin source: ${manifestPath} not found` };
  }

  // 2. Validate manifest.
  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  } catch (err) {
    return { ok: false, reason: `invalid plugin manifest (${manifestPath}): ${errorMessage(err)}` };
  }

  // 3. Secret-scan the declared hooks + mcpServers surface. A baked credential
  //    is rejected outright — never install a manifest carrying one.
  const secret = scanManifestSecrets(manifest);
  if (secret) {
    return { ok: false, reason: secret };
  }

  // 4. M1 path containment for every manifest-declared path.
  const pathReject = checkManifestPaths(manifest, sourceAbs);
  if (pathReject) {
    return { ok: false, reason: pathReject };
  }

  // 5. Symlink-escape — reject an out-of-tree/dangling symlink before consent
  //    (copySkillTree re-checks at copy; this fails loud up front).
  try {
    await assertNoSymlinkEscape(sourceAbs);
  } catch (err) {
    return { ok: false, reason: `refusing to install: ${errorMessage(err)}` };
  }

  // 6. Refuse to overwrite an existing install without force (before confirm).
  const targetDir = join(opts.pluginsRoot, manifest.name);
  if (existsSync(targetDir) && opts.force !== true) {
    return {
      ok: false,
      reason: `plugin '${manifest.name}' already installed at ${targetDir}. Use force:true to overwrite, or run \`/plugins uninstall ${manifest.name}\` first.`,
    };
  }

  // 7. Guard-scan prompt content + detect bundled scripts.
  let scan: ComponentScan;
  try {
    scan = await scanComponents(sourceAbs, manifest);
  } catch (err) {
    return { ok: false, reason: `could not scan plugin content: ${errorMessage(err)}` };
  }

  // 8. Build the disclosure.
  const disclosure = buildDisclosure(manifest, scan);

  // 9. Consent.
  let accepted: boolean;
  try {
    accepted = await opts.confirm(disclosure);
  } catch (err) {
    return { ok: false, reason: `consent prompt failed: ${errorMessage(err)}` };
  }
  if (!accepted) {
    return { ok: false, declined: true };
  }

  // 10. Land the tree, hash the COPIED tree, mint + write consent.
  try {
    await mkdir(opts.pluginsRoot, { recursive: true });
    if (existsSync(targetDir)) {
      await rm(targetDir, { recursive: true, force: true });
    }
    await copySkillTree(sourceAbs, targetDir);
    const treeHash = hashPluginTree(targetDir);
    const record = buildConsentRecord({
      pluginId: manifest.name,
      version: manifest.version,
      treeHash,
      decisions: { ...PLUGIN_CONSENT_DECISIONS },
      consentedAt: opts.now ?? new Date().toISOString(),
    });
    writeConsent(targetDir, record);
  } catch (err) {
    return { ok: false, reason: `failed to install to ${targetDir}: ${errorMessage(err)}` };
  }

  return {
    ok: true,
    name: manifest.name,
    installedAt: targetDir,
    skillCount: scan.skillCount,
    commandCount: scan.commandCount,
  };
}

// ----- uninstall -----

export interface UninstallPluginOptions {
  /** Plugin name (manifest `name`) — its install-dir segment. */
  name: string;
  /** The `<harnessHome>/plugins/` root. Uninstall only touches one level under it. */
  pluginsRoot: string;
}

export interface UninstallPluginSuccess {
  ok: true;
  name: string;
  removedFrom: string;
}

export interface UninstallPluginError {
  ok: false;
  reason: string;
}

export type UninstallPluginResult = UninstallPluginSuccess | UninstallPluginError;

/**
 * Uninstall a plugin by name. Mirrors `uninstallSkill` exactly for safety:
 * validates the name is a safe segment, then defense-in-depth path containment
 * (the target must resolve UNDER `pluginsRoot` AND exactly one level deep)
 * before removing the dir (incl. `.consent.json` + any enable records).
 */
export async function uninstallPlugin(
  opts: UninstallPluginOptions,
): Promise<UninstallPluginResult> {
  if (!PLUGIN_NAME_RE.test(opts.name)) {
    return { ok: false, reason: `invalid plugin name: ${opts.name}` };
  }
  const name = opts.name;

  const targetDir = join(opts.pluginsRoot, name);
  if (!existsSync(targetDir)) {
    return { ok: false, reason: `plugin '${name}' is not installed at ${targetDir}.` };
  }

  // Defense in depth: confirm targetDir is exactly one level under pluginsRoot.
  const rootAbs = resolve(opts.pluginsRoot);
  const targetAbs = resolve(targetDir);
  if (!isOneLevelUnder(rootAbs, targetAbs)) {
    return { ok: false, reason: `refusing to remove path outside plugins root: ${targetAbs}` };
  }

  try {
    await rm(targetDir, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, reason: `failed to remove ${targetDir}: ${errorMessage(err)}` };
  }
  return { ok: true, name, removedFrom: targetDir };
}

// ----- gate 3: manifest secret scan (H2) -----

/** Scan the declared hooks + mcpServers blocks for a literal secret. Returns a
 *  rejection reason (naming the offending field) on a hit, else null. */
function scanManifestSecrets(manifest: PluginManifest): string | null {
  const surface: Record<string, unknown> = {};
  if (manifest.hooks) surface.hooks = manifest.hooks;
  if (manifest.mcpServers) surface.mcpServers = manifest.mcpServers;
  const findings = scanObjectForSecrets(surface);
  const first = findings[0];
  if (!first) return null;
  const field = first.path.length > 0 ? first.path : '<manifest>';
  return `refusing to install: manifest field '${field}' embeds what looks like a literal secret (${first.reason}). Plugins must reference secrets via env, never bake them in.`;
}

// ----- gate 4: M1 path containment -----

/** Check every manifest-declared path stays UNDER the source root. Rejects
 *  absolute paths and `../` escapes, checking BOTH the raw value and the
 *  `${CLAUDE_PLUGIN_ROOT}`-substituted value. Returns a reason on a violation. */
function checkManifestPaths(manifest: PluginManifest, sourceAbs: string): string | null {
  for (const candidate of collectManifestPaths(manifest)) {
    const reject = pathContainmentReject(candidate.label, candidate.value, sourceAbs);
    if (reject) return reject;
  }
  return null;
}

type PathCandidate = { label: string; value: string };

/** Gather every manifest-declared path-like string with its field label. The
 *  always-path fields (the skills/commands dir overrides, mcp stdio
 *  command/args/cwd) are collected unconditionally; any other string carrying
 *  the `${CLAUDE_PLUGIN_ROOT}` token is collected too (so a hook command that
 *  references the plugin root is containment-checked). Pure. */
function collectManifestPaths(manifest: PluginManifest): PathCandidate[] {
  const out: PathCandidate[] = [];
  out.push({ label: 'skills', value: manifest.skills });
  out.push({ label: 'commands', value: manifest.commands });

  for (const [alias, server] of Object.entries(manifest.mcpServers ?? {})) {
    if (server.type === 'stdio') {
      out.push({ label: `mcpServers.${alias}.command`, value: server.command });
      if (server.cwd) out.push({ label: `mcpServers.${alias}.cwd`, value: server.cwd });
      for (const [i, arg] of (server.args ?? []).entries()) {
        out.push({ label: `mcpServers.${alias}.args.${i}`, value: arg });
      }
    }
  }

  // Any other string carrying the plugin-root token must also stay contained.
  for (const tokenRef of collectPluginRootTokenRefs(manifest)) {
    out.push(tokenRef);
  }
  return out;
}

/** Find every string leaf in the hooks/mcp surface that contains the
 *  `${CLAUDE_PLUGIN_ROOT}` token (e.g. a hook command referencing a bundled
 *  script), so its resolved location is containment-checked. */
function collectPluginRootTokenRefs(manifest: PluginManifest): PathCandidate[] {
  const out: PathCandidate[] = [];
  const surface: Record<string, unknown> = {};
  if (manifest.hooks) surface.hooks = manifest.hooks;
  if (manifest.mcpServers) surface.mcpServers = manifest.mcpServers;
  walkStrings(surface, '', (path, value) => {
    if (value.includes(PLUGIN_ROOT_TOKEN)) out.push({ label: path, value });
  });
  return out;
}

/** Reject an absolute path or a `../`-escaping declared path. Checks the raw
 *  value AND the `${CLAUDE_PLUGIN_ROOT}`-substituted value, both resolved
 *  against the source root, mirroring `assertNoSymlinkEscape`'s containment. */
function pathContainmentReject(label: string, value: string, sourceAbs: string): string | null {
  for (const variant of pathVariants(value, sourceAbs)) {
    if (isAbsolutePath(variant.raw)) {
      return `refusing to install: manifest path '${label}' = '${value}' is absolute; declared paths must stay under the plugin root.`;
    }
    const resolved = resolve(sourceAbs, variant.raw);
    if (!isWithin(sourceAbs, resolved)) {
      return `refusing to install: manifest path '${label}' = '${value}' escapes the plugin root.`;
    }
  }
  return null;
}

/** The path forms to containment-check: the value as-is, and (when present)
 *  the value with `${CLAUDE_PLUGIN_ROOT}` rewritten to the source root. */
function pathVariants(value: string, sourceAbs: string): { raw: string }[] {
  const variants: { raw: string }[] = [{ raw: value }];
  if (value.includes(PLUGIN_ROOT_TOKEN)) {
    variants.push({ raw: value.split(PLUGIN_ROOT_TOKEN).join(sourceAbs) });
  }
  return variants;
}

/** True for an absolute path (POSIX `/…` or a Windows drive/UNC root). */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

// ----- gate 7: guard-scan + bundled-script detection (S5/M2) -----

/**
 * Guard-scan the plugin's prompt-bearing content the way the LOADER will, then
 * detect bundled scripts + reference files.
 *
 * Disclosure-fidelity (T6 review #1): the loader enumerates a `skills/`/
 * `commands/` tree per-COMPONENT — a directory-skill (a dir holding `SKILL.md`)
 * is ONE skill whose guard verdict AGGREGATES its `SKILL.md` + every sibling
 * reference file (incl. non-`.md`, e.g. `payload.txt`); loose `.md` files are
 * single-file components. We mirror that exactly so the disclosure's per-skill
 * count + block/allow verdict match what the loader actually enforces: a
 * dir-skill with a clean `SKILL.md` but a guard-tripping sibling is disclosed as
 * ⛔ disabled-by-policy (not a clean active contribution).
 *
 * A guard `block` disables that component by policy (disclosed, not installed-
 * as-active); scripts + reference files are disclosed, never blocked.
 */
async function scanComponents(sourceAbs: string, manifest: PluginManifest): Promise<ComponentScan> {
  const skillsDir = join(sourceAbs, manifest.skills);
  const commandsDir = join(sourceAbs, manifest.commands);

  const disabled: GuardedComponent[] = [];
  const advisories: GuardAdvisory[] = [];

  const skillCount = await guardScanComponentTree(
    skillsDir,
    'skill',
    sourceAbs,
    disabled,
    advisories,
  );
  const commandCount = await guardScanComponentTree(
    commandsDir,
    'command',
    sourceAbs,
    disabled,
    advisories,
  );

  // Bundled scripts anywhere under the source tree (incl. inside components).
  const allFiles = await listFiles(sourceAbs);
  const scriptFiles = allFiles.filter(isScript);
  const scripts = scriptFiles.map((f) => relPosix(sourceAbs, f)).sort();
  // Scan each script's raw content for guard escalations (disclosed, not blocked).
  for (const file of scriptFiles) {
    const text = await readFileSafe(file);
    if (text === null) continue;
    const decision = guardSkillText(text, 'community');
    for (const finding of decision.findings) {
      if (finding.level === 'medium' || finding.level === 'critical') {
        advisories.push({
          component: relPosix(sourceAbs, file),
          level: finding.level,
          category: finding.category,
        });
      }
    }
  }

  // Bundled reference files: non-`.md`, non-script files under skills/ +
  // commands/ (incl. siblings inside a directory-skill, e.g. `payload.txt`).
  // Disclosed so the operator sees content that the per-`.md` view hid; their
  // guard relevance is already folded into the owning skill's aggregated verdict.
  const referenceFiles = [...(await listFiles(skillsDir)), ...(await listFiles(commandsDir))]
    .filter((f) => !isMarkdown(f) && !isScript(f))
    .map((f) => relPosix(sourceAbs, f))
    .sort();

  return {
    skillCount,
    commandCount,
    totalComponents: skillCount + commandCount,
    disabled,
    advisories,
    scripts,
    referenceFiles,
  };
}

/**
 * Enumerate + guard-scan one component dir (`skills/` or `commands/`) the way
 * the loader's `listMarkdownFiles` walk does, returning the per-component count.
 * For each component file:
 *  - a `SKILL.md` (a directory-skill) → `guardSkillLoad` (AGGREGATES the dir's
 *    `SKILL.md` + sibling reference files, matching the loader at community tier);
 *  - a loose `.md` (a single-file skill/command) → `guardSkillText` on its body.
 * A `block` verdict pushes a disabled component (counted, NOT active); other
 * medium/critical findings become advisories.
 */
async function guardScanComponentTree(
  dir: string,
  kind: 'skill' | 'command',
  sourceAbs: string,
  disabled: GuardedComponent[],
  advisories: GuardAdvisory[],
): Promise<number> {
  const componentFiles = await listComponentFiles(dir);
  for (const file of componentFiles) {
    const text = await readFileSafe(file);
    if (text === null) continue;
    // Mirror the loader: a SKILL.md is guarded with its whole directory
    // (sibling reference files included); a loose .md is guarded alone.
    const decision = isDirectorySkillFile(file)
      ? await guardSkillLoad({ path: file, raw: text, trustTier: 'community' })
      : guardSkillText(text, 'community');
    const name = relPosix(sourceAbs, file);
    if (decision.action === 'block') {
      const first = decision.findings[0];
      disabled.push({
        kind,
        name,
        reason: first ? `${first.category} pattern` : 'guard policy',
      });
      continue;
    }
    for (const finding of decision.findings) {
      if (finding.level === 'medium' || finding.level === 'critical') {
        advisories.push({ component: name, level: finding.level, category: finding.category });
      }
    }
  }
  return componentFiles.length;
}

/**
 * List the component FILES under a `skills/`/`commands/` dir with the loader's
 * exact per-component semantics (mirrors `listMarkdownFiles` in
 * `src/skills/loader.ts`): a directory containing `SKILL.md` is a directory-
 * skill — emit ONLY its `SKILL.md` and do NOT descend (siblings are reference
 * files, folded into that skill's aggregated guard); otherwise recurse and emit
 * each loose `.md` file as a single-file component. Absent dir ⇒ []. */
async function listComponentFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  await walkComponentFiles(dir, out);
  return out.sort();
}

// NOTE: same per-component rule as the skill loader's `walk`
// (`src/skills/loader.ts`) and the sync `countComponentDir` in
// `src/plugins/snapshot.ts` — a `SKILL.md` dir is one component (no descent),
// else recurse and emit loose `.md`s. This copy is async + collects paths (vs
// snapshot's sync count); the sync/async + shape split is why they are not one
// shared helper. Keep all three in sync.
async function walkComponentFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const skillMd = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md',
  );
  if (skillMd) {
    // Directory-skill: one component, guarded with its whole dir; stop here.
    out.push(join(dir, skillMd.name));
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkComponentFiles(path, out);
      continue;
    }
    if (entry.isFile() && isMarkdown(entry.name)) out.push(path);
  }
}

/** True for a `SKILL.md` file (case-insensitive) — a directory-skill's entry
 *  point, guarded with its whole directory by the loader. */
function isDirectorySkillFile(file: string): boolean {
  return basename(file).toLowerCase() === 'skill.md';
}

// ----- shared helpers -----

function isMarkdown(file: string): boolean {
  return file.toLowerCase().endsWith('.md');
}

function isScript(file: string): boolean {
  const lower = file.toLowerCase();
  return SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Recursively list every regular file under `dir` (absolute paths). A
 *  symlink/socket/etc. is excluded (only `isFile()`); an absent dir yields []. */
async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  await walkFiles(dir, out);
  return out;
}

async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(path, out);
      continue;
    }
    if (entry.isFile()) out.push(path);
  }
}

async function readFileSafe(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Walk every string leaf of an object/array, invoking `visit(path, value)`. */
function walkStrings(
  node: unknown,
  path: string,
  visit: (path: string, value: string) => void,
): void {
  if (typeof node === 'string') {
    visit(path, node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkStrings(item, path === '' ? String(i) : `${path}.${i}`, visit));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walkStrings(child, path === '' ? key : `${path}.${key}`, visit);
    }
  }
}

/** Relative POSIX path of `file` under `root` (forward slashes on all platforms). */
function relPosix(root: string, file: string): string {
  const rel = file.startsWith(root) ? file.slice(root.length).replace(/^[\\/]/, '') : file;
  return sep === '/' ? rel : rel.split(sep).join('/');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
