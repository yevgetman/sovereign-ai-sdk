import { z } from 'zod';
import { DEFAULT_SKILL_DISCOVERY_LIMITS } from '../skills/discovery.js';

export const ApprovalRootsSchema = z
  .array(z.string().min(1))
  .max(DEFAULT_SKILL_DISCOVERY_LIMITS.maxRoots);
export const LayeredSkillSettingsSchema = z
  .object({
    discovery: z.object({ allowedLinkRoots: ApprovalRootsSchema.optional() }).strict().optional(),
  })
  .strict();
export const ProfileSkillSettingsSchema = z
  .object({
    discovery: z
      .object({
        projectRoot: z.string().min(1).optional(),
        allowedLinkRoots: ApprovalRootsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
