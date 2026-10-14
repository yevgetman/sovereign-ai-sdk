/** Keychain record. Never log these fields. */

export type SubscriptionRecord = {
  /** Random nonsecret login lineage. Never derived from token material. */
  accountBinding?: string;
  accessToken: string;
  refreshToken: string;
  /** Unix time in milliseconds. */
  expiresAt: number;
};

/**
 * Where a subscription token lives. The Mac adapter uses `security`.
 * Tests pass a fake. No production call reads the Keychain from a test.
 */
/** Narrow fetch. Tests pass a fake. Global `fetch` still assigns. */
export type SubscriptionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SubscriptionCredentialPort {
  /** Cross-process mutex metadata. Production adapters must provide both. */
  readonly lockDirectory?: string;
  readonly lockIdentity?: string;
  read(service: string): Promise<SubscriptionRecord | null>;
  write(service: string, record: SubscriptionRecord): Promise<void>;
  delete(service: string): Promise<void>;
}

/** Only locally generated UUIDs may become nonsecret persisted provider state. */
export function isSubscriptionAccountBinding(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
}
