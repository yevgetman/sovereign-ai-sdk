// Skill loader and prompt expansion. Scans user/project/bundle skill
// directories, parses markdown frontmatter, and lazily expands skill bodies
// when a slash command or SkillTool invokes one.

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  DEFAULT_SKILL_DISCOVERY_LIMITS,
  type SkillClassification,
  type SkillDiscoveryOptions,
  discoverSkills,
} from './discovery.js';
import { splitCommaList, splitFrontmatter } from './frontmatter.js';
import { type SkillGuardResourceBudget, formatGuardBlockMessage, guardSkillLoad } from './guard.js';
import type { Skill, SkillExpansionOptions, SkillHarnessMetadata, SkillRegistry } from './types.js';
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

export type { SkillClassification, SkillRoot } from './discovery.js';
export type LoadSkillsOptions = SkillDiscoveryOptions;

export async function loadSkills(opts: LoadSkillsOptions): Promise<SkillRegistry> {
  const discovery = await discoverSkills(opts);
  const byName = new Map<string, Skill>();
  const skills: Skill[] = [];
  const readBudget: SkillGuardResourceBudget = {
    bytesRemaining: discovery.limits.maxTotalBytes,
    entriesRemaining: Math.max(0, discovery.limits.maxEntries - discovery.entriesVisited),
    fileBytesLimit: discovery.limits.maxFileBytes,
    depthLimit: discovery.limits.maxDepth,
  };
  for (const candidate of discovery.candidates) {
    const budget = Math.min(discovery.limits.maxFileBytes, readBudget.bytesRemaining);
    const loaded = await loadSkillFile(
      candidate.path,
      candidate.realpath,
      candidate.classification,
      opts.warn,
      candidate.root.pluginRoot,
      budget,
      readBudget,
    );
    const decision = {
      path: candidate.path,
      realpath: candidate.realpath,
      root: candidate.root.path,
      source: candidate.classification.source,
      trustTier: candidate.classification.trustTier,
    };
    if (!loaded) {
      opts.onDiscoveryDecision?.({
        ...decision,
        code: 'load-rejected',
        message: 'skill validation, guard or read limit rejected the file',
      });
      continue;
    }
    if (byName.has(loaded.name)) {
      opts.warn?.(`skill skipped (${candidate.path}): duplicate skill name '${loaded.name}'`);
      opts.onDiscoveryDecision?.({
        ...decision,
        code: 'duplicate-name',
        message: `duplicate skill name '${loaded.name}'`,
      });
      continue;
    }
    byName.set(loaded.name, loaded);
    skills.push(loaded);
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
    ? await interpolateShellCommands(text, skill.dir, env, opts.runShellCommand)
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
  const currentRealpath = await realpath(skill.path);
  const expectedRealpath = skill.revision
    ? skill.realpath
    : join(await realpath(dirname(skill.realpath)), basename(skill.realpath));
  if (currentRealpath !== expectedRealpath) {
    throw new Error(`skill '${skill.name}' changed its resolved path; reload the registry`);
  }
  const loaded = await loadSkillFile(
    skill.path,
    currentRealpath,
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
  maxBytes = DEFAULT_SKILL_DISCOVERY_LIMITS.maxFileBytes,
  resourceBudget?: SkillGuardResourceBudget,
): Promise<Skill | null> {
  try {
    const budget = resourceBudget ?? {
      bytesRemaining: DEFAULT_SKILL_DISCOVERY_LIMITS.maxTotalBytes,
      entriesRemaining: DEFAULT_SKILL_DISCOVERY_LIMITS.maxEntries,
      fileBytesLimit: maxBytes,
      depthLimit: DEFAULT_SKILL_DISCOVERY_LIMITS.maxDepth,
    };
    const raw = await readBoundedSkillFile(path, rp, maxBytes, (bytes) => {
      budget.bytesRemaining -= bytes;
    });
    const guard = await guardSkillLoad({
      path: rp,
      raw,
      resourceBudget: budget,
      ...(basename(path).toLowerCase() === 'skill.md' ? { resourceRoot: dirname(rp) } : {}),
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
      revision: createHash('sha256').update(raw).digest('hex'),
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

async function readBoundedSkillFile(
  path: string,
  rp: string,
  maxBytes: number,
  onRead?: (bytes: number) => void,
): Promise<string> {
  if (maxBytes <= 0) throw new Error('skill discovery read budget exhausted');
  if ((await realpath(path)) !== rp || (await realpath(rp)) !== rp)
    throw new Error('skill real path changed before reading');
  const handle = await open(rp, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('skill content must be a regular file');
    if (info.size > maxBytes) throw new Error('skill file exceeds the bounded read limit');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    onRead?.(Math.min(length, maxBytes));
    if (length > maxBytes) throw new Error('skill file exceeds the bounded read limit');
    const current = await stat(rp);
    if (
      (await realpath(path)) !== rp ||
      (await realpath(rp)) !== rp ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    )
      throw new Error('skill real path or file identity changed while reading');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

// Resolve env placeholders SPAN-AWARE, then run each author inline-shell span.
// The scan runs over the RAW body (placeholders intact) so an env value can
// never invent a NEW `` !`cmd` `` span, and each value is single-quoted only as
// it is interpolated into the command that reaches bash — inert shell data
// (`substituteEnvCommand`) — while prose regions keep the sanitized display value
// (`substituteEnvProse`). Command output is inserted verbatim, never re-scanned
// or re-substituted.
async function interpolateShellCommands(
  body: string,
  cwd: string,
  env: SkillEnv,
  runShellCommand: SkillExpansionOptions['runShellCommand'],
): Promise<string> {
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
    if (!runShellCommand) {
      throw new Error('skill inline shell requires an explicit permissioned host runner');
    }
    out += truncateShellOutput((await runShellCommand(command, cwd)).trimEnd());
  }
  out += substituteEnvProse(body.slice(lastIndex), env);
  return out;
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
