// Input validation for the `:id` path parameter on /sessions/:id and
// /sessions/:id/events routes. Session ids are UUIDs in production but the
// validator only enforces the character class — the lookup will 404 if the
// id is shaped right but doesn't exist. Rejecting empty/malformed ids here
// prevents the id from being echoed unsanitized into SSE event payloads or
// session DB queries.

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidSessionId(id: string): boolean {
  return id.length > 0 && SESSION_ID_PATTERN.test(id);
}
