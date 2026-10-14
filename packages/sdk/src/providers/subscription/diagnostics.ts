/** Upstream bodies are untrusted and may echo credentials, ciphertext or prompts.
 * Keep only known codes and fixed diagnostic templates. Never retain raw text. */
export type UpstreamDiagnostic = { status: number; code?: string; message: string };
const SAFE_CODES = new Set([
  'invalid_request_error',
  'invalid_request',
  'bad_request',
  'missing_required_parameter',
  'missing_required_field',
  'invalid_parameter',
  'invalid_value',
  'validation_error',
  'model_not_found',
  'invalid_model',
  'unknown_model',
  'rate_limit_exceeded',
  'context_length_exceeded',
  'too_many_tokens',
  'insufficient_quota',
  'server_error',
  'authentication_error',
  'invalid_api_key',
  'unauthorized',
  'permission_denied',
  'forbidden',
  'insufficient_permissions',
]);

export function subscriptionDiagnostic(status: number, body: string): UpstreamDiagnostic {
  let row: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>;
      const error = envelope.error;
      row =
        error && typeof error === 'object' && !Array.isArray(error)
          ? (error as Record<string, unknown>)
          : envelope;
    }
  } catch {
    /* HTML, malformed and truncated bodies are discarded. */
  }
  const candidate = typeof row.code === 'string' ? row.code : row.type;
  const code = typeof candidate === 'string' && SAFE_CODES.has(candidate) ? candidate : undefined;
  const raw = typeof row.message === 'string' ? row.message : '';
  // Match only a provider contract template and known field. Arbitrary trailing
  // text is never copied, even if the provider echoes a whole request there.
  const missing =
    /missing required (?:parameter|field)\s*:\s*['"]?(?:input\[\d{1,6}\]\.)?(summary|encrypted_content|type)['"]?(?:[.\s]|$)/i.exec(
      raw,
    );
  const message = missing
    ? `Missing required reasoning field: ${missing[1]?.toLowerCase()}.`
    : status === 401
      ? 'Upstream subscription login was rejected.'
      : status === 403
        ? 'Upstream subscription access was denied.'
        : status === 413 || code === 'context_length_exceeded' || code === 'too_many_tokens'
          ? 'Request exceeds the upstream model context limit.'
          : code === 'model_not_found' || code === 'invalid_model' || code === 'unknown_model'
            ? 'Selected upstream model is unavailable.'
            : 'Upstream request failed; unsafe details were redacted.';
  return { status, ...(code ? { code } : {}), message };
}
