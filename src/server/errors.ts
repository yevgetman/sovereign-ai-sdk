// Error classes thrown by src/server/runtime.ts. Kept in a separate
// module so tests + tuiLauncher can `instanceof`-check without pulling
// in the full runtime boot transitive surface.

import type { ProviderPreflightKind } from '../providers/preflight.js';

export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export class PreflightError extends Error {
  readonly kind: ProviderPreflightKind;
  constructor(kind: ProviderPreflightKind, message: string, cause?: Error) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'PreflightError';
    this.kind = kind;
  }
}
