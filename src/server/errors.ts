// Error classes thrown by src/server/runtime.ts. Kept in a separate
// module so tests + tuiLauncher can `instanceof`-check without pulling
// in the full runtime boot transitive surface.

export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}
