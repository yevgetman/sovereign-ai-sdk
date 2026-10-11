import type { Skill } from './types.js';

/** Unknown fields stay data. Native restrictions and portable pre-approval
 * requests deliberately have separate representations. */
export type SkillDescriptor = {
  schemaVersion: 1;
  invocation: { user: boolean; model: boolean };
  execution: { supported: boolean; diagnostics: SkillCompatibilityDiagnostic[] };
  toolPolicy: { restrictedTools: string[]; preapprovedTools: string[] };
  frontmatter: Record<string, unknown>;
};

export type SkillCompatibilityDiagnostic = {
  code: string;
  severity: 'warning' | 'error';
  field: string;
  message: string;
};

/** Split portable comma OR whitespace lists without splitting tool arguments. */
export function parseSkillToolList(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry !== 'string'))
      throw new Error('skill tool lists must contain strings');
    return value.flatMap((entry) => parseSkillToolList(entry));
  }
  if (value === undefined) return [];
  if (typeof value !== 'string') throw new Error('skill tool list must be a string or list');
  const result: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function control(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`skill '${key}' must be a boolean`);
  return value;
}

export function normalizeSkillDescriptor(raw: Record<string, unknown>): SkillDescriptor {
  const diagnostics: SkillCompatibilityDiagnostic[] = [];
  const unsupported = (field: string, message: string) => {
    diagnostics.push({ code: 'unsupported-execution-control', severity: 'error', field, message });
  };
  if (raw.context !== undefined && raw.context !== 'inline') {
    unsupported(
      'context',
      'SOV supports inline skills only; remove context or use context: inline. Fork isolation is not implemented.',
    );
  }
  if (raw.model !== undefined && raw.model !== 'inherit') {
    unsupported(
      'model',
      'Per-skill model overrides are not implemented; select the host model or use model: inherit.',
    );
  }
  if (raw.hooks !== undefined)
    unsupported(
      'hooks',
      'Per-skill hooks are not implemented; configure hooks through the host permission path.',
    );
  if (raw.agent !== undefined)
    unsupported(
      'agent',
      'Per-skill agent routing is not implemented; invoke a host agent explicitly.',
    );
  for (const field of ['permissions', 'permission-mode', 'execution-mode', 'sandbox']) {
    if (raw[field] !== undefined)
      unsupported(field, `Unsupported skill '${field}' control cannot change host authority.`);
  }
  const preapprovedTools = parseSkillToolList(raw['allowed-tools']);
  if (preapprovedTools.length) {
    diagnostics.push({
      code: 'portable-preapproval-request',
      severity: 'warning',
      field: 'allowed-tools',
      message:
        'Portable allowed-tools requests pre-approval. SOV preserves the request but checks every tool with host policy. Native allowedTools restricts the turn tool pool.',
    });
  }
  return {
    schemaVersion: 1,
    invocation: {
      user: control(raw, 'user-invocable', true),
      model: !control(raw, 'disable-model-invocation', false),
    },
    execution: { supported: !diagnostics.some((entry) => entry.severity === 'error'), diagnostics },
    toolPolicy: { restrictedTools: parseSkillToolList(raw.allowedTools), preapprovedTools },
    frontmatter: { ...raw },
  };
}

export function isSkillInvocable(skill: Skill, source: 'user' | 'model' | 'command'): boolean {
  const descriptor = skill.descriptor;
  if (!descriptor) return true;
  return (
    descriptor.execution.supported && descriptor.invocation[source === 'model' ? 'model' : 'user']
  );
}

export function assertSkillInvocable(skill: Skill, source: 'user' | 'model' | 'command'): void {
  if (isSkillInvocable(skill, source)) return;
  const diagnostic = skill.descriptor?.execution.diagnostics.find(
    (entry) => entry.severity === 'error',
  );
  throw new Error(
    diagnostic
      ? `skill '${skill.name}' cannot activate: ${diagnostic.message}`
      : `skill '${skill.name}' does not permit ${source === 'model' ? 'model' : 'user'} invocation`,
  );
}

/** Parse positional arguments as data, never with a shell. */
export function splitSkillArguments(value: string): string[] {
  const result: string[] = [];
  let token = '';
  let quote = '';
  let started = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      token += char;
      started = true;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        result.push(token);
        token = '';
        started = false;
      }
    } else {
      token += char;
      started = true;
    }
  }
  if (escaped) token += '\\';
  if (started) result.push(token);
  return result;
}

export function substituteSkillArguments(text: string, args: string): string {
  const positional = splitSkillArguments(args);
  return text.replace(
    /\{\{\s*args\s*\}\}|\$ARGUMENTS\b(?:\[(\d+)\])?|\$(\d+)\b/g,
    (match, index: string | undefined, short: string | undefined) => {
      if (match.startsWith('{{') || (index === undefined && short === undefined)) return args;
      return positional[Number(index ?? short)] ?? '';
    },
  );
}
