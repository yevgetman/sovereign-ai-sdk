/** Subscription provider names. They are not API-key providers. */

export const SUBSCRIPTION_NAMES = ['chatgpt', 'claude-max', 'grok'] as const;

export type SubscriptionName = (typeof SUBSCRIPTION_NAMES)[number];

export const KEYCHAIN_SERVICE: Record<SubscriptionName, string> = {
  chatgpt: 'SOV_SUB_CHATGPT',
  'claude-max': 'SOV_SUB_CLAUDE_MAX',
  grok: 'SOV_SUB_GROK',
};

/**
 * Built-in default model per usable subscription backend. Read by the resolver
 * and by the route registry (`chatgpt-subscription` / `grok-subscription`).
 * Verify against live service behavior before claiming live support.
 */
export const SUBSCRIPTION_DEFAULT_MODEL: Record<Exclude<SubscriptionName, 'claude-max'>, string> = {
  chatgpt: 'gpt-5.3-codex',
  grok: 'grok-4.6',
};

export function isSubscriptionName(name: string): name is SubscriptionName {
  return (SUBSCRIPTION_NAMES as readonly string[]).includes(name);
}
