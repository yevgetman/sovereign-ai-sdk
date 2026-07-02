// InputTransformer that scrubs known-secret patterns out of Write,
// Edit, and NotebookEdit inputs before the tool dispatches.
//
// Why this exists: an agent that explores the system can find secrets
// (in .zshrc, in stripe configs, in .netrc, etc.) and then accidentally
// reproduce them verbatim into a generated artifact (a security audit
// report, a redacted-config example, a debug dump). This transformer
// catches that failure class at the boundary — independent of model
// quality or skill prompt discipline.
//
// Field selection: we redact `content` (Write), `new_string` (Edit), and
// `new_source` (NotebookEdit). We deliberately do NOT redact Edit's
// `old_string` — the user's legitimate workflow for REMOVING a secret
// from a file is to pass the live secret as `old_string` so it matches
// the file content. Redacting `old_string` would break that workflow.
//
// We also do NOT cover Bash commands. Catching `echo gho_xxx > file`
// requires shell parsing and is best left to a separate pass if needed.
// The original failure mode (audit report writing the live token to
// disk) went through Write, which this covers.

import type { Tool } from '../tool/types.js';
import type { InputTransformer } from './inputTransformer.js';
import { redactSecrets } from './secretRedactor.js';

/**
 * Tools and the input fields whose string contents should be scanned.
 * Keyed on both the canonical tool name (FileWrite, FileEdit) and the
 * Claude-Code-style aliases (Write, Edit) so the transformer matches
 * regardless of which name the orchestrator presents.
 */
const REDACTABLE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['FileWrite', ['content']],
  ['Write', ['content']],
  ['FileEdit', ['new_string']],
  ['Edit', ['new_string']],
  ['NotebookEdit', ['new_source']],
]);

function resolveFields(tool: Tool<unknown, unknown>): readonly string[] | undefined {
  const direct = REDACTABLE_FIELDS.get(tool.name);
  if (direct) return direct;
  // Tool definitions may declare aliases (e.g. FileWrite has alias 'Write').
  // Check those too so a future rename can't silently disable the redactor.
  const aliases = (tool as { aliases?: readonly string[] }).aliases;
  if (!aliases) return undefined;
  for (const alias of aliases) {
    const fields = REDACTABLE_FIELDS.get(alias);
    if (fields) return fields;
  }
  return undefined;
}

export const redactSecretsTransformer: InputTransformer = async (
  tool: Tool<unknown, unknown>,
  input: unknown,
) => {
  const fields = resolveFields(tool);
  if (!fields) return undefined;
  if (input === null || typeof input !== 'object') return undefined;

  const obj = input as Record<string, unknown>;
  let mutated: Record<string, unknown> | null = null;
  const kinds: string[] = [];
  let totalHits = 0;

  for (const field of fields) {
    const value = obj[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    const result = redactSecrets(value);
    if (result.hits.length === 0) continue;
    if (!mutated) mutated = { ...obj };
    mutated[field] = result.redacted;
    totalHits += result.hits.length;
    for (const h of result.hits) kinds.push(h.kind);
  }

  if (!mutated) return undefined;

  const uniqueKinds = [...new Set(kinds)].sort();
  return {
    updatedInput: mutated,
    reason: `redacted ${totalHits} secret${totalHits === 1 ? '' : 's'} (${uniqueKinds.join(', ')})`,
  };
};
