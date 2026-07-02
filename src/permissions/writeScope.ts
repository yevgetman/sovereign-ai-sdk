// Write-scope enforcement (2026-06-15 — multi-agent workflows). A workflow
// task may declare a write scope (path globs); the path-lock then lets disjoint
// scopes run in parallel. To make that PARALLELISM SAFE even when an author
// under-declares, this guard ENFORCES the scope as a permission boundary: a
// child whose task declared `writes: [globs]` is DENIED any write outside those
// globs, so a stray write fails closed (a denied tool call) rather than racing a
// sibling task. Disjoint declared scopes therefore provably cannot clash.
//
// Coverage: structured file writes (any tool exposing affectedPaths —
// FileWrite/FileEdit + aliases) are checked path-by-path; write-capable Bash is
// denied outright in a narrowly-scoped task (the shell's write targets can't be
// verified statically — the task should use the file tools within scope, or
// declare `writes: ['**']` for the whole tree, which also serializes). Harness-
// state tools (memory/skills/instincts, which write under the harness home, not
// the project tree) are governed by normal permissions.

import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import { isReadOnlyBashCommand } from '../tools/BashTool.js';
import type { CanUseTool, ResolvedPermissionResult } from './types.js';

const GLOB_CHARS = /[*?[\]{}]/;

/** picomatch options pinned to `Bun.Glob.match` parity (2026-07-01, Task 2.2 —
 *  the matcher previously WAS Bun.Glob; Node compatibility forced the swap, and
 *  because this gate is a SECURITY boundary the replacement must be neither
 *  more permissive nor more restrictive). Empirically verified row-by-row by
 *  tests/permissions/writeScopeGlobParity.test.ts, which generates expectations
 *  from Bun.Glob at test time:
 *  - `dot: true` — Bun.Glob matches dotfiles with `*`/`**` (`'*'` matches
 *    `.env`); picomatch's default (dot: false) would silently NARROW the scope.
 *  - `strictSlashes: true` — Bun.Glob does NOT match the bare base directory
 *    with a trailing globstar (`'src/**'` vs `'src'` is false); picomatch's
 *    default would WIDEN the gate to the base path itself. */
export const WRITE_SCOPE_PICOMATCH_OPTIONS = { dot: true, strictSlashes: true } as const;

/** Tools that write under `$HARNESS_HOME` (harness state — memory, agent-created
 *  skills), NOT the project tree. Their `affectedPaths` return bare markers
 *  (`memory`, `skills/agent-created/<n>/SKILL.md`) that would be spuriously
 *  matched against the project-tree globs, so they are EXEMPT from the
 *  project-scope check and governed by normal permissions (per the module
 *  header). 2026-06-15 review fix — without this they were wrongly DENIED in any
 *  narrowly-scoped task. */
const HARNESS_STATE_TOOLS: ReadonlySet<string> = new Set(['memory', 'skill_manage']);

/** Resolve a tool path (absolute / `~/` / cwd-relative) to a cwd-relative path
 *  for glob matching. */
function toCwdRelative(p: string, cwd: string): string {
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return relative(cwd, abs);
}

/** True when one cwd-relative path matches a declared glob. A bare directory
 *  glob (no wildcard) matches its whole subtree, mirroring the path-lock's
 *  containing-directory collapse — so `writes: ['migrations']` admits writes to
 *  `migrations/001.sql` (2026-06-15 review fix: previously `Bun.Glob('migrations')`
 *  matched only the literal `migrations`, denying every write under it). */
function matchesGlob(glob: string, rel: string): boolean {
  try {
    if (picomatch(glob, WRITE_SCOPE_PICOMATCH_OPTIONS)(rel)) return true;
  } catch {
    // fall through to the bare-directory check
  }
  if (!GLOB_CHARS.test(glob)) {
    const dir = glob.replace(/\/+$/, '');
    if (rel === dir || rel.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/** True when `p` is inside the declared write scope. A path that escapes cwd
 *  (relative starts with `..`, or resolves to cwd itself) is out of scope. */
function inScope(p: string, globs: string[], cwd: string): boolean {
  const rel = toCwdRelative(p, cwd);
  if (rel === '' || rel.startsWith('..')) return false;
  return globs.some((g) => matchesGlob(g, rel));
}

const ALLOW: ResolvedPermissionResult = { behavior: 'allow' };

/**
 * Wrap a child's CanUseTool so writes outside `globs` are denied. When `base`
 * is present, an in-scope write defers to it (the scope check is an ADDITIONAL
 * gate, never a loosening); when absent, an in-scope write is allowed.
 *
 * Enforcement order (2026-06-15 review hardening):
 *  1. read-only tools → defer to base (they never write the project tree);
 *  2. harness-state writers (memory/skills) → defer to base (write under
 *     $HARNESS_HOME, not the project tree);
 *  3. Bash → deny write-capable shell in a narrow scope;
 *  4. a write-capable tool with structured affectedPaths → check each path;
 *     EMPTY affectedPaths from such a tool FAILS CLOSED (denied) rather than
 *     falling through to allow — a write tool that reports no path could write
 *     outside the scope undetectably.
 */
export function wrapCanUseToolWithWriteScope(
  base: CanUseTool | undefined,
  globs: string[],
): CanUseTool {
  const deferOrAllow: CanUseTool = (tool, input, ctx) =>
    base !== undefined ? base(tool, input, ctx) : Promise.resolve(ALLOW);
  return async (tool, input, ctx): Promise<ResolvedPermissionResult> => {
    if (typeof tool.isReadOnly === 'function' && tool.isReadOnly(input)) {
      return deferOrAllow(tool, input, ctx);
    }
    if (HARNESS_STATE_TOOLS.has(tool.name)) {
      return deferOrAllow(tool, input, ctx);
    }
    if (tool.name === 'Bash') {
      const cmd =
        typeof input === 'object' && input !== null
          ? (input as { command?: unknown }).command
          : undefined;
      if (typeof cmd === 'string' && !isReadOnlyBashCommand(cmd)) {
        return {
          behavior: 'deny',
          reason:
            "this task declares a narrow write scope; write-capable shell commands are denied (declare writes: ['**'] for unrestricted writes)",
        };
      }
      return deferOrAllow(tool, input, ctx);
    }
    const affected =
      typeof tool.affectedPaths === 'function' ? tool.affectedPaths(input) : undefined;
    if (affected !== undefined) {
      if (affected.length === 0) {
        return {
          behavior: 'deny',
          reason: `${tool.name} reports no affected path; denied under this task's declared write scope (${globs.join(', ')})`,
        };
      }
      for (const p of affected) {
        if (!inScope(p, globs, ctx.cwd)) {
          return {
            behavior: 'deny',
            reason: `write to '${p}' is outside this task's declared write scope (${globs.join(', ')})`,
          };
        }
      }
    }
    return deferOrAllow(tool, input, ctx);
  };
}
