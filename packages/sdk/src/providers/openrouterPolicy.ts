import { z } from 'zod';

// Endpoint slugs are publisher-defined. Validate shape, not a frozen allowlist,
// so new providers and endpoint variants do not require an SDK release.
const hosts = z.array(z.string().trim().min(1).max(200)).min(1);
export const OpenRouterPolicySchema = z
  .object({
    order: hosts.optional(),
    only: hosts.optional(),
    ignore: hosts.optional(),
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(['allow', 'deny']).optional(),
    zdr: z.boolean().optional(),
    enforce_distillable_text: z.boolean().optional(),
    sort: z.enum(['price', 'throughput', 'latency']).optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    // Contradictory choices must fail rather than silently widen routing.
    if (policy.only?.some((host) => policy.ignore?.includes(host))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only and ignore must not overlap' });
    }
    if (policy.order?.some((host) => policy.ignore?.includes(host))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'order and ignore must not overlap' });
    }
    if (policy.only && policy.order?.some((host) => !policy.only?.includes(host))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ordered hosts must be allowed by only',
      });
    }
  });

/** OpenRouter inference endpoints, independent of the model author prefix.
 * Omitted policy preserves OpenRouter defaults. A strict host pin uses `only`
 * plus `allow_fallbacks: false`; `order` alone is a preference, not a pin. */
export type OpenRouterPolicy = z.infer<typeof OpenRouterPolicySchema>;

export function validateOpenRouterPolicy(policy: OpenRouterPolicy): OpenRouterPolicy {
  return OpenRouterPolicySchema.parse(policy);
}
