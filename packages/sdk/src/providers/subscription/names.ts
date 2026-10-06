/** Subscription provider names. They are not API-key providers. */

export const SUBSCRIPTION_NAMES = ['chatgpt', 'claude-max', 'grok'] as const;

export type SubscriptionName = (typeof SUBSCRIPTION_NAMES)[number];

export const KEYCHAIN_SERVICE: Record<SubscriptionName, string> = {
  chatgpt: 'SOV_SUB_CHATGPT',
  'claude-max': 'SOV_SUB_CLAUDE_MAX',
  grok: 'SOV_SUB_GROK',
};

export function isSubscriptionName(name: string): name is SubscriptionName {
  return (SUBSCRIPTION_NAMES as readonly string[]).includes(name);
}
