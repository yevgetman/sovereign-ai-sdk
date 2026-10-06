import { SubscriptionAuthExpiredError } from '../errors.js';
import type { SubscriptionRecord } from './port.js';

/** Build the Keychain record from a token endpoint JSON body. Never echoes the tokens. */
export function recordFromTokenJson(
  provider: string,
  body: unknown,
  nowMs: number,
  previousRefresh: string,
): SubscriptionRecord {
  if (!body || typeof body !== 'object') {
    throw new SubscriptionAuthExpiredError(provider);
  }
  const row = body as Record<string, unknown>;
  const accessToken = typeof row.access_token === 'string' ? row.access_token : '';
  const refreshToken =
    typeof row.refresh_token === 'string' && row.refresh_token.length > 0
      ? row.refresh_token
      : previousRefresh;
  if (accessToken.length === 0 || refreshToken.length === 0) {
    throw new SubscriptionAuthExpiredError(provider);
  }
  let expiresAt = nowMs + 60 * 60 * 1000;
  if (typeof row.expires_in === 'number' && Number.isFinite(row.expires_in)) {
    expiresAt = nowMs + row.expires_in * 1000;
  }
  return { accessToken, refreshToken, expiresAt };
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function formBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  return params.toString();
}
