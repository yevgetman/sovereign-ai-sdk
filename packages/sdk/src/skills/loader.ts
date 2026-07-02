// Skill loader and prompt expansion. Scans user/project/bundle skill
// directories, parses markdown frontmatter, and lazily expands skill bodies
// when a slash command or SkillTool invokes one.

import { existsSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { spawnProc } from '../util/spawn.js';
import { splitCommaList, splitFrontmatter } from './frontmatter.js';
import { formatGuardBlockMessage, guardSkillLoad } from './guard.js';
import type {
  Skill,
  SkillExpansionOptions,
  SkillHarnessMetadata,
  SkillRegistry,
  SkillSource,
  SkillTrustTier,
} from './types.js';
import { validateWhenToUse } from './whenToUse.js';

const MetadataHarnessSchema = z
  .object({
    requires_toolsets: z.array(z.string()).default([]),
    requires_tools: z.array(z.string()).default([]),
    fallback_for_toolsets: z.array(z.string()).default([]),
    fallback_for_tools: z.array(z.string()).default([]),
  })
  .default({});

const MetadataSchema = z
  .object({
    harness: MetadataHarnessSchema,
  })
  .default({});

/** Normalize Claude Code frontmatter into the harness-native shape before
 *  validation. CC uses the hyphenated `allowed-tools` key (this harness uses
 *  camelCase `allowedTools`) and frequently writes it as a single
 *  comma-separated STRING (e.g. `allowed-tools: Read, Grep, Bash(git status:*)`)
 *  rather than a YAML list — which `z.array(z.string())` would reject outright.
 *
 *  Two transforms, both no-ops for harness-native files:
 *    1. alias `allowed-tools` → `allowedTools` ONLY when `allowedTools` is
 *       absent (a file carrying both keeps its harness-native value — no clobber);
 *    2. when the resulting `allowedTools` value is a string, split on commas
 *       into a trimmed, non-empty array.
 *
 *  Runs in front of SkillFrontmatterSchema so any CC SKILL.md loads natively
 *  with its tool list populated.
 *
 *  Exported so the import write path (`normalizeImportedFrontmatter` in
 *  install.ts) applies the EXACT same field transform — the alias + comma-split
 *  rule must live in ONE place (F9), never re-implemented. */
export function normalizeFrontmatterAliases(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  // Drop the hyphenated CC key by omission (immutable; no `delete`), aliasing
  // it onto `allowedTools` only when the harness-native key is absent.
  const { 'allowed-tools': hyphenated, ...rest } = obj;
  const next: Record<string, unknown> = { ...rest };
  if (!('allowedTools' in next) && hyphenated !== undefined) {
    next.allowedTools = hyphenated;
  }
  if (typeof next.allowedTools === 'string') {
    next.allowedTools = splitCommaList(next.allowedTools);
  }
  return next;
}

export const SkillFrontmatterSchema = z.preprocess(
  normalizeFrontmatterAliases,
  z
    .object({
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'must be a slash-command-safe name'),
      description: z.string().min(1),
      allowedTools: z.array(z.string()).default([]),
      whenToUse: z.string().default(''),
      metadata: MetadataSchema,
    })
    .passthrough(),
);

const SHELL_INTERPOLATION_RE = /(?:`!([^`]+)`|!`([^`]+)`)/g;
const SHELL_TIMEOUT_MS = 10_000;
const SHELL_OUTPUT_CAP = 16 * 1024;

/** The trusted environment placeholders a skill body may reference. Every value
 *  is caller/filesystem-derived DATA (a session id, a skill directory, a plugin
 *  root) — never a shell identifier — so it must never be able to alter the shape
 *  of a command. */
type SkillEnv = {
  HARNESS_SKILL_DIR: string;
  HARNESS_SESSION_ID: string;
  CLAUDE_PLUGIN_ROOT: string;
};

const ENV_PLACEHOLDER_RE = /\$\{(HARNESS_SKILL_DIR|HARNESS_SESSION_ID|CLAUDE_PLUGIN_ROOT)\}/g;

/** Neutralize the backtick / `$` / backslash class in a SUBSTITUTED env value
 *  before it is inserted into skill PROSE (F27 + R1).
 *
 *  Prose is display text, never re-scanned for inline shell, but a value that
 *  visually reconstructs a `` !`cmd` `` token (backtick) or a `$(…)` / `${…}`
 *  expansion is still stripped as defense-in-depth so it can never be mistaken
 *  for one. Parens/braces are deliberately PRESERVED (they are common, inert in
 *  prose). This is the PROSE-only neutralizer; the COMMAND context uses
 *  `stripDoubleQuote` + `shellSingleQuote` instead — see below. */
function sanitizeInlineShellSigil(value: string): string {
  return value.replace(/[`$\\]/g, '');
}

/** Remove the double-quote char `"` from a substituted env value. Single-quoting
 *  (below) neutralizes a value in a BARE or author-single-quoted context, but if
 *  a skill AUTHOR wraps the placeholder in THEIR OWN double quotes
 *  (`cat "${HARNESS_SKILL_DIR}/x"`) the wrapping single quotes become LITERAL
 *  inside that double-quoted string, so a value carrying a `"` could terminate
 *  the author's string and inject a new command. Stripping `"` closes that
 *  author-double-quote breakout. `"` is not a legal path char on the platforms
 *  this SDK ships on, so removing it cannot corrupt a legitimate skill path. */
function stripDoubleQuote(value: string): string {
  return value.replace(/"/g, '');
}

/** Wrap a value in single quotes so EVERY character inside — spaces, `;`, `|`,
 *  `&`, `(`, `)`, `<`, `>`, newline, `$`, backtick, backslash — is inert shell
 *  DATA. In POSIX single quotes NOTHING is special except the closing quote, so
 *  a literal single quote is emitted as `'\''` (close-quote, escaped-quote,
 *  reopen-quote), the standard idiom. This is the primary neutralizer for
 *  env-value command injection in a BARE or author-single-quoted span: the value
 *  can never become a command separator or a new substitution, and it also fixes
 *  word-splitting for legitimate paths that contain spaces or `$`.
 *
 *  Injection model (not "every context is closed by single-quoting" — that
 *  overclaimed): the value lands in one of two author contexts —
 *    - BARE / author-single-quoted → THIS single-quoting makes it inert;
 *    - author-DOUBLE-quoted → the paired `stripDoubleQuote` prevents a `"`
 *      breakout (see its note).
 *  The genuinely-untrusted input is HARNESS_SESSION_ID, guarded at the boundary
 *  by validateSessionId (rejects shell metachars); HARNESS_SKILL_DIR /
 *  CLAUDE_PLUGIN_ROOT come from a supported install. This layer is
 *  defense-in-depth on top of that. Single-quoting is kept as the primary rather
 *  than STRIPPING `$`/backtick/backslash, because stripping silently corrupts a
 *  legit path containing `$` (e.g. `/x/$stuff/skill`) while single-quoting
 *  neutralizes those same chars losslessly. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Substitute env placeholders in PROSE (non-shell) text: each value is inserted
 *  as sanitized display text. Function replacer so a `$`-sequence in the value is
 *  never treated as a `.replace` special pattern. */
function substituteEnvProse(text: string, env: SkillEnv): string {
  return text.replace(ENV_PLACEHOLDER_RE, (_full, name: keyof SkillEnv) =>
    sanitizeInlineShellSigil(env[name]),
  );
}

/** Substitute env placeholders INSIDE the command of an inline-shell span: the
 *  double-quote char is stripped (kills the author-double-quote breakout) and the
 *  value is single-quoted (kills the bare / author-single-quote context). No
 *  `$`/backtick/backslash STRIP: single-quoting already neutralizes them and
 *  stripping would corrupt a legit path containing `$`. */
function substituteEnvCommand(command: string, env: SkillEnv): string {
  return command.replace(ENV_PLACEHOLDER_RE, (_full, name: keyof SkillEnv) =>
    shellSingleQuote(stripDoubleQuote(env[name])),
  );
}

export type LoadSkillsOptions = {
  harnessHome: string;
  cwd: string;
  /** When set, scans bundle-relative skill roots; absent in generic-agent mode. */
  bundleRoot?: string;
  /** Extra skill roots spliced in AFTER project+user, BEFORE bundle roots —
   *  precedence `project > user > extraRoots > bundle`. T4/compose passes the
   *  plugin SkillRoots here. Because dedupe is first-wins by name, an extraRoot
   *  skill can override a bundle skill but can NEVER shadow a user/project skill
   *  of the same name (the H2 no-shadow property). */
  extraRoots?: SkillRoot[];
  warn?: (message: string) => void;
};

/** The (source, trustTier) pair a skill root stamps on its skills. Exported
 *  (Task 2.9) because the public `SkillRoot.classify` signature references it —
 *  every type reachable from the SDK barrel surface must be nameable. */
export type SkillClassification = {
  source: SkillSource;
  trustTier: SkillTrustTier;
};

export type SkillRoot = SkillClassification & {
  path: string;
  classify?: (file: string) => SkillClassification;
  /** Plugin install dir for a `source:'plugin'` root. Propagated onto every
   *  Skill loaded from this root so the body can resolve `${CLAUDE_PLUGIN_ROOT}`.
   *  Absent for non-plugin roots — the substitution falls back to ''. */
  pluginRoot?: string;
};

export async function loadSkills(opts: LoadSkillsOptions): Promise<SkillRegistry> {
  const roots: SkillRoot[] = [
    {
      source: 'project',
      trustTier: 'trusted',
      path: join(opts.cwd, '.harness', 'skills'),
    },
    {
      source: 'user',
      trustTier: 'trusted',
      path: join(opts.harnessHome, 'skills'),
      classify: (file) => classifyUserSkill(file, join(opts.harnessHome, 'skills')),
    },
    // Plugin (and any caller-supplied) roots rank below user/project but above
    // bundle. First-wins-by-name dedupe makes this the H2 no-shadow boundary.
    ...(opts.extraRoots ?? []),
  ];
  if (opts.bundleRoot !== undefined) {
    roots.push(
      { source: 'bundle', trustTier: 'builtin', path: join(opts.bundleRoot, 'skills') },
      {
        source: 'bundle',
        trustTier: 'trusted',
        path: join(opts.bundleRoot, 'harness', 'skills-trusted'),
      },
      {
        source: 'community',
        trustTier: 'community',
        path: join(opts.bundleRoot, 'skills-community'),
      },
    );
  }

  const seenRealpaths = new Set<string>();
  const byName = new Map<string, Skill>();
  const skills: Skill[] = [];

  for (const root of roots) {
    for (const file of await listMarkdownFiles(root.path)) {
      let rp: string;
      try {
        rp = await realpath(file);
      } catch (err) {
        opts.warn?.(`skill skipped (${file}): ${errorMessage(err)}`);
        continue;
      }
      if (seenRealpaths.has(rp)) continue;
      seenRealpaths.add(rp);

      const classification = root.classify?.(file) ?? root;
      const loaded = await loadSkillFile(file, rp, classification, opts.warn, root.pluginRoot);
      if (!loaded) continue;
      if (byName.has(loaded.name)) {
        opts.warn?.(`skill skipped (${file}): duplicate skill name '${loaded.name}'`);
        continue;
      }
      byName.set(loaded.name, loaded);
      skills.push(loaded);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, byName };
}

export async function expandSkillPrompt(
  skill: Skill,
  opts: SkillExpansionOptions,
): Promise<string> {
  return expandSkillText(skill, skill.body, opts);
}

export async function expandSkillText(
  skill: Skill,
  text: string,
  opts: SkillExpansionOptions,
): Promise<string> {
  const args = opts.args ?? '';
  const argsTrimmed = args.trim();
  const hasPlaceholder = /\{\{\s*args\s*\}\}/.test(text);

  // Trusted environment placeholders (skill dir, session id, plugin root). These
  // are DATA (a caller-supplied session id, a filesystem path), never shell
  // identifiers, so where a value lands governs how it is neutralized:
  //   - in PROSE it is inserted as sanitized display text (`substituteEnvProse`);
  //   - INSIDE an author's inline-shell span it is single-quoted AND its `"` is
  //     stripped so it is inert shell data in both the bare/single-quoted and the
  //     author-double-quoted context (`substituteEnvCommand`, applied at exec by
  //     `interpolateShellCommands`).
  // The command-context model is single-quote + strip-`"`, NOT "every context is
  // closed by single-quoting" (single quotes go LITERAL inside an author's own
  // double quotes — the `"` strip is what closes that span). The genuinely
  // untrusted input, HARNESS_SESSION_ID, is denylist-validated at the boundary
  // (validateSessionId); this layer is defense-in-depth (C1 was HARNESS_SKILL_DIR
  // with `;`, R1 was HARNESS_SESSION_ID with `$(…)`, round-6 was the author-`"`
  // breakout). Model/user `args` are NEVER an env value here: they are merged LAST
  // as inert text (audit 2026-06-10) so a `` `!cmd` `` in args can never reach the
  // shell.
  const env: SkillEnv = {
    HARNESS_SKILL_DIR: skill.dir,
    HARNESS_SESSION_ID: opts.sessionId ?? '',
    // CC-compat: a plugin skill/command body names its bundled files via
    // ${CLAUDE_PLUGIN_ROOT}. Resolves to the plugin install dir for
    // plugin-sourced skills; '' otherwise (so the var never renders literally).
    CLAUDE_PLUGIN_ROOT: skill.pluginRoot ?? '',
  };

  // Defense in depth: gate on the field AND re-check the source. Even a
  // mis-constructed plugin Skill with `allowShellInterpolation: true` must NOT
  // run shell — the `source !== 'plugin'` clause is the backstop. With shell off
  // every placeholder is resolved as prose.
  const shellAllowed = skill.allowShellInterpolation && skill.source !== 'plugin';
  const body = shellAllowed
    ? await interpolateShellCommands(text, skill.dir, env)
    : substituteEnvProse(text, env);

  // Merge args as INERT text: substitute {{args}} and/or append them. Skills
  // that don't reference {{args}} would otherwise silently drop the user's slash
  // arguments, so append them (e.g. `/review ~/code/babyboard/`).
  let result = body.replace(/\{\{\s*args\s*\}\}/g, () => args);
  if (argsTrimmed && !hasPlaceholder) {
    result += `\n\nUser arguments: ${argsTrimmed}`;
  }
  return result;
}

export async function reloadSkill(skill: Skill, warn?: (message: string) => void): Promise<Skill> {
  const loaded = await loadSkillFile(
    skill.path,
    skill.realpath,
    { source: skill.source, trustTier: skill.trustTier },
    warn,
    // Preserve the plugin root across reloads so a plugin command's
    // ${CLAUDE_PLUGIN_ROOT} still resolves when re-expanded per invocation.
    skill.pluginRoot,
  );
  if (!loaded) throw new Error(`skill '${skill.name}' could not be reloaded`);
  return loaded;
}

export async function loadSkillFromPath(
  path: string,
  classification: SkillClassification,
  warn?: (message: string) => void,
  pluginRoot?: string,
): Promise<Skill | null> {
  try {
    return await loadSkillFile(path, await realpath(path), classification, warn, pluginRoot);
  } catch (err) {
    warn?.(`skill skipped (${path}): ${errorMessage(err)}`);
    return null;
  }
}

async function loadSkillFile(
  path: string,
  rp: string,
  classification: SkillClassification,
  warn?: (message: string) => void,
  pluginRoot?: string,
): Promise<Skill | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const guard = await guardSkillLoad({
      path,
      raw,
      trustTier: classification.trustTier,
    });
    if (guard.action === 'block') {
      warn?.(`skill skipped (${path}): ${formatGuardBlockMessage(guard)}`);
      return null;
    }
    const parsed = parseMarkdownFrontmatter(raw);
    const frontmatter = SkillFrontmatterSchema.parse(parsed.frontmatter);
    const rigor = validateWhenToUse(frontmatter.whenToUse);
    if (!rigor.ok) {
      warn?.(`skill '${frontmatter.name}' (${path}): ${rigor.reason}`);
    }
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      whenToUse: frontmatter.whenToUse,
      allowedTools: frontmatter.allowedTools,
      path,
      realpath: rp,
      dir: dirname(path),
      source: classification.source,
      trustTier: classification.trustTier,
      // Forced by source — NOT manifest-controlled. Plugin skills never run
      // inline shell (it bypasses the permission layer); everything else does.
      allowShellInterpolation: classification.source !== 'plugin',
      // Carried only for plugin-sourced skills; resolves ${CLAUDE_PLUGIN_ROOT}.
      // Conditionally spread so the key is ABSENT (not `undefined`) for
      // non-plugin skills — required under exactOptionalPropertyTypes.
      ...(pluginRoot !== undefined ? { pluginRoot } : {}),
      metadata: {
        harness: normalizeHarnessMetadata(frontmatter.metadata.harness),
      },
      guard,
      body: parsed.body.trim(),
    };
  } catch (err) {
    warn?.(`skill skipped (${path}): ${errorMessage(err)}`);
    return null;
  }
}

function classifyUserSkill(file: string, root: string): SkillClassification {
  const firstSegment = relative(root, file).split(sep)[0];
  if (firstSegment === 'agent-created') {
    return { source: 'agent-created', trustTier: 'agent-created' };
  }
  if (firstSegment === 'trusted' || firstSegment === basename(file)) {
    return { source: 'user', trustTier: 'trusted' };
  }
  return { source: 'community', trustTier: 'community' };
}

function normalizeHarnessMetadata(
  raw: z.infer<typeof MetadataHarnessSchema>,
): SkillHarnessMetadata {
  return {
    requiresToolsets: raw.requires_toolsets,
    requiresTools: raw.requires_tools,
    fallbackForToolsets: raw.fallback_for_toolsets,
    fallbackForTools: raw.fallback_for_tools,
  };
}

function parseMarkdownFrontmatter(raw: string): { frontmatter: unknown; body: string } {
  // Delegate the raw split to the shared splitter (identical CRLF-tolerant
  // regex), then parse the YAML — keeps the loader and install/import on one
  // frontmatter shape.
  const { frontmatter, body } = splitFrontmatter(raw);
  return { frontmatter: parseYaml(frontmatter), body };
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  await walk(root, out);
  return out.sort();
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const directorySkill = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md',
  );
  if (directorySkill) {
    out.push(join(dir, directorySkill.name));
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, out);
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      out.push(path);
    }
  }
}

// Resolve env placeholders SPAN-AWARE, then run each author inline-shell span.
// The scan runs over the RAW body (placeholders intact) so an env value can
// never invent a NEW `` !`cmd` `` span, and each value is single-quoted only as
// it is interpolated into the command that reaches bash — inert shell data
// (`substituteEnvCommand`) — while prose regions keep the sanitized display value
// (`substituteEnvProse`). Command output is inserted verbatim, never re-scanned
// or re-substituted.
async function interpolateShellCommands(body: string, cwd: string, env: SkillEnv): Promise<string> {
  const matches = Array.from(body.matchAll(SHELL_INTERPOLATION_RE));
  if (matches.length === 0) return substituteEnvProse(body, env);
  let out = '';
  let lastIndex = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    const full = match[0];
    out += substituteEnvProse(body.slice(lastIndex, start), env);
    lastIndex = start + full.length;
    const rawCommand = (match[1] ?? match[2])?.trim();
    if (!rawCommand) {
      // Empty sigil (e.g. all-whitespace): keep it as inert text.
      out += substituteEnvProse(full, env);
      continue;
    }
    const command = substituteEnvCommand(rawCommand, env);
    // Command stdout is inserted verbatim; no `.replace`, so a `$`-sequence in
    // the output ($1/$2 in awk, prices, git diffs) is never treated as special.
    out += await runInterpolationCommand(command, cwd);
  }
  out += substituteEnvProse(body.slice(lastIndex), env);
  return out;
}

async function runInterpolationCommand(command: string, cwd: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SHELL_TIMEOUT_MS);
  try {
    const proc = spawnProc(['bash', '-lc', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: ctl.signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return `[inline-shell error: ${command}\nexit_code: ${exitCode}\n${stderr.trimEnd()}]`;
    }
    return truncateShellOutput(stdout.trimEnd());
  } catch (err) {
    return `[inline-shell error: ${command}\n${errorMessage(err)}]`;
  } finally {
    clearTimeout(timer);
  }
}

function truncateShellOutput(text: string): string {
  if (text.length <= SHELL_OUTPUT_CAP) return text;
  return `${text.slice(0, SHELL_OUTPUT_CAP)}\n[truncated: shell interpolation exceeded ${SHELL_OUTPUT_CAP} chars]`;
}

function errorMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}
