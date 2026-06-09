// Plugin manifest schema (T1). Models the Claude-Code `plugin.json` shape as a
// STRICT KNOWN-SUBSET: identity + convention-discovered component dirs + the
// declared-but-inert `hooks`/`mcpServers` blocks. It is deliberately NOT
// `.strict()`-rejecting — a real CC plugin carries keys the harness does not
// consume in v1 (e.g. `agents`, `keywords`, `homepage`). Those unknown
// top-level keys are collected into an explicit `ignored: string[]` so the
// consent disclosure can list exactly what the harness ignores, rather than
// silently dropping (or rejecting) them.
//
// The `hooks`/`mcpServers` blocks REUSE the canonical settings schemas
// (`HooksSettingsSchema`, `McpServerConfigSchema`) — they are validated here
// purely for disclosure (well-formed accepted, malformed rejected) and are
// NEVER executed in v1. Do not duplicate those definitions.

import { z } from 'zod';
import { HooksSettingsSchema, McpServerConfigSchema } from '../config/settings.js';

/** A plugin name must be a lowercase, hyphen-separated slug — the install dir
 *  segment and the inter-plugin sort key. */
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** The top-level keys the harness consumes. Everything else is unknown/CC-only
 *  and is collected into `ignored[]`. Kept in one place so the transform and
 *  any future surface agree on what "known" means. */
const KNOWN_KEYS = [
  'name',
  'version',
  'description',
  'author',
  'skills',
  'commands',
  'hooks',
  'mcpServers',
] as const;

// The validated, known-subset shape — BEFORE the ignored[] transform. Uses
// `.passthrough()` so unknown keys survive validation and can be partitioned
// out (a `.strip()` default would discard them; `.strict()` would reject the
// whole manifest — neither lets us disclose them).
const PluginManifestKnownSchema = z
  .object({
    name: z.string().regex(PLUGIN_NAME_RE, 'must be a lowercase hyphen-separated slug'),
    version: z.string().min(1),
    description: z.string().min(1),
    author: z.string().optional(),
    /** Relative dir holding the plugin's skills. CC convention: `skills`. */
    skills: z.string().default('skills'),
    /** Relative dir holding the plugin's slash commands. CC convention: `commands`. */
    commands: z.string().default('commands'),
    /** Declared-but-inert in v1 — validated for disclosure only, never run. */
    hooks: HooksSettingsSchema.optional(),
    /** Declared-but-inert in v1 — validated for disclosure only, never connected. */
    mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  })
  .passthrough();

/** The plugin manifest schema. Parses a (validated) known subset and partitions
 *  every unknown top-level key into `ignored[]`. Pure — the transform builds a
 *  new object and never mutates the input. */
export const PluginManifestSchema = PluginManifestKnownSchema.transform((parsed) => {
  const known = new Set<string>(KNOWN_KEYS);
  const ignored: string[] = [];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (known.has(key)) {
      result[key] = value;
    } else {
      ignored.push(key);
    }
  }
  return { ...result, ignored } as PluginManifest;
});

/** The known-subset fields the transform retains, plus `ignored[]`. Declared
 *  explicitly (rather than `z.infer`) because the transform's output is an
 *  intersection that is clearer to express as a named type that later tasks
 *  depend on. */
export type PluginManifest = {
  name: string;
  version: string;
  description: string;
  author?: string;
  skills: string;
  commands: string;
  hooks?: z.infer<typeof HooksSettingsSchema>;
  mcpServers?: Record<string, z.infer<typeof McpServerConfigSchema>>;
  /** Unknown / CC-only top-level keys, collected for the consent disclosure. */
  ignored: string[];
};

/** Parse untrusted manifest JSON into a `PluginManifest`. Throws a `ZodError`
 *  on any validation failure (bad name, malformed hooks/mcpServers, …). Pure —
 *  Zod returns a new object; the input is never mutated. */
export function parsePluginManifest(raw: unknown): PluginManifest {
  return PluginManifestSchema.parse(raw);
}
