// Settings schema. Zod-validated; strict (unknown keys rejected). Phase 5
// adds provider defaults and credentials; later phases add project layering.
//
// Source of pattern: Claude Code src/schemas/.

import { z } from 'zod';

const CredentialConfigSchema = z
  .object({
    id: z.string().optional(),
    apiKey: z.string().optional(),
    token: z.string().optional(),
    priority: z.number().int().optional(),
  })
  .strict();

const ProviderConfigSchema = z
  .object({
    apiKey: z.string().optional(),
    apiKeys: z.array(z.string()).optional(),
    credentials: z.array(CredentialConfigSchema).optional(),
    model: z.string().optional(),
    baseUrl: z.string().url().optional(),
    strategy: z.enum(['ROUND_ROBIN', 'LEAST_USED', 'FILL_FIRST']).optional(),
    /** Ollama only: explicit num_ctx override sent on every request.
     *  Defaults to the model's registered contextLength when unset. */
    numCtx: z.number().int().positive().optional(),
  })
  .strict();

const MicrocompactionSchema = z
  .object({
    enabled: z.boolean().optional(),
    keepRecent: z.number().int().positive().optional(),
    triggerThresholdPct: z.number().min(0).max(100).optional(),
  })
  .strict();

const CompactionSchema = z
  .object({
    /** When the system prompt + history exceeds this percentage of the
     *  model's context window, the REPL preemptively compacts the
     *  session before the next provider call. Default 50. Raise toward
     *  80–90 to keep more history around (helpful for small-context
     *  local models like qwen2.5:7b at 32K). */
    proactiveThresholdPct: z.number().min(1).max(99).optional(),
  })
  .strict();

/** Developer-facing flags pinned for harness building/debugging. The
 *  umbrella `enabled` flag is a convenience switch — when true, every
 *  child capability behaves as if it were also true. Children can still
 *  be set individually for fine-grained control when the umbrella is
 *  unset. The CLI can still override individual settings per session. */
const DebugModeSchema = z
  .object({
    /** Master switch. When true, all child capabilities (currently:
     *  `transcript`) auto-enable regardless of their individual values. */
    enabled: z.boolean().optional(),
    /** When true (or when `enabled` is true), each REPL session writes a
     *  redacted JSONL transcript under `transcriptDir`. */
    transcript: z.boolean().optional(),
    /** Directory for auto-generated transcript files. Tilde and
     *  relative paths are expanded against the harness home /
     *  process cwd at REPL startup. Defaults to `<harnessHome>/debug`
     *  (i.e. `~/.harness/debug`). */
    transcriptDir: z.string().optional(),
  })
  .strict();

export const SettingsSchema = z
  .object({
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    permissionMode: z.enum(['default', 'ask', 'bypass']).optional(),
    /** Maximum number of model turns inside a single user query before
     *  the runtime stops with `[max turns reached]`. One turn = one
     *  assistant message; tool_use turns count, so analysis tasks that
     *  read many files need a higher cap. Default 30. */
    maxTurns: z.number().int().positive().optional(),
    providers: z
      .object({
        anthropic: ProviderConfigSchema.optional(),
        openai: ProviderConfigSchema.optional(),
        openrouter: ProviderConfigSchema.optional(),
        ollama: ProviderConfigSchema.optional(),
      })
      .strict()
      .optional(),
    microcompaction: MicrocompactionSchema.optional(),
    compaction: CompactionSchema.optional(),
    debugMode: DebugModeSchema.optional(),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
