// Settings schema. Zod-validated; strict (unknown keys rejected). Layered
// precedence: managed > user > project > projectLocal. Phase 0: minimal.
//
// Source of pattern: Claude Code src/schemas/.

import { z } from 'zod';

export const SettingsSchema = z
  .object({
    defaultModel: z.string().optional(),
    permissionMode: z.enum(['default', 'ask', 'bypass']).optional(),
    providers: z
      .object({
        anthropic: z
          .object({
            apiKey: z.string().optional(), // reads ANTHROPIC_API_KEY env if unset
            model: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    // More fields land with future phases.
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;
