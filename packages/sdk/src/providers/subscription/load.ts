import { ChatGptSubscriptionProvider } from '../chatgpt.js';
import { ClaudeMaxTermsError, CredentialUnavailableError } from '../errors.js';
import { GrokSubscriptionProvider } from '../grok.js';
import type { LLMProvider } from '../types.js';
import type { AttemptDeps } from './attempt.js';
import { CLAUDE_MAX_TERMS_MESSAGE } from './claudeMaxTerms.js';
import { macKeychainPort } from './keychain.js';
import { isSubscriptionName } from './names.js';
import type { SubscriptionCredentialPort, SubscriptionFetch } from './port.js';

export type LoadSubscriptionOpts = {
  /** A gateway turn has a principal. The port is not read. */
  principal?: string;
  fetchImpl?: SubscriptionFetch;
  deps?: AttemptDeps;
};

/**
 * Build a subscription provider for the local owner process.
 * `claude-max` fails before the port and before any HTTP.
 * A principal fails the same way: the gateway cannot use these logins.
 */
export function loadSubscriptionProvider(
  name: string,
  port?: SubscriptionCredentialPort,
  opts: LoadSubscriptionOpts = {},
): LLMProvider {
  if (!isSubscriptionName(name)) {
    throw new CredentialUnavailableError(name);
  }
  if (opts.principal !== undefined) {
    throw new CredentialUnavailableError(
      name,
      `subscription provider ${name} is not available to a gateway principal`,
    );
  }
  if (name === 'claude-max') {
    throw new ClaudeMaxTermsError(CLAUDE_MAX_TERMS_MESSAGE);
  }
  const credentialPort = port ?? macKeychainPort();
  const shared = {
    port: credentialPort,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.deps ? { deps: opts.deps } : {}),
  };
  if (name === 'chatgpt') return new ChatGptSubscriptionProvider(shared);
  return new GrokSubscriptionProvider(shared);
}
