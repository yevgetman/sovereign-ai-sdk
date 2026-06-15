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
import { isReadOnlyBashCommand } from '../tools/BashTool.js';
import type { CanUseTool, ResolvedPermissionResult } from './types.js';

/** Resolve a tool path (absolute / `~/` / cwd-relative) to a cwd-relative path
 *  for glob matching. */
function toCwdRelative(p: string, cwd: string): string {
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return relative(cwd, abs);
}

/** True when `p` is inside the declared write scope. A path that escapes cwd
 *  (relative starts with `..`, or resolves to cwd itself) is out of scope. */
function inScope(p: string, globs: string[], cwd: string): boolean {
  const rel = toCwdRelative(p, cwd);
  if (rel === '' || rel.startsWith('..')) return false;
  return globs.some((g) => {
    try {
      return new Bun.Glob(g).match(rel);
    } catch {
      return false;
    }
  });
}

const ALLOW: ResolvedPermissionResult = { behavior: 'allow' };

/**
 * Wrap a child's CanUseTool so writes outside `globs` are denied. When `base`
 * is present, an in-scope write defers to it (the scope check is an ADDITIONAL
 * gate, never a loosening); when absent, an in-scope write is allowed.
 */
export function wrapCanUseToolWithWriteScope(
  base: CanUseTool | undefined,
  globs: string[],
): CanUseTool {
  return async (tool, input, ctx): Promise<ResolvedPermissionResult> => {
    const affected =
      typeof tool.affectedPaths === 'function' ? tool.affectedPaths(input) : undefined;
    if (affected !== undefined && affected.length > 0) {
      for (const p of affected) {
        if (!inScope(p, globs, ctx.cwd)) {
          return {
            behavior: 'deny',
            reason: `write to '${p}' is outside this task's declared write scope (${globs.join(', ')})`,
          };
        }
      }
    } else if (tool.name === 'Bash') {
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
    }
    return base !== undefined ? base(tool, input, ctx) : ALLOW;
  };
}
