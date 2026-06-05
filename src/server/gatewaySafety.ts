// Phase A T5 — refuse-to-boot safety guard for `sov gateway`.
//
// Pure guard the gateway entrypoint calls before binding. assertGatewaySafe
// throws iff the bind host is off-loopback AND no/empty token is configured,
// so the tool-running agent is never exposed remotely without auth. No I/O,
// no mutation; isLoopbackHost is the reusable predicate.

/**
 * True for the loopback host. We accept the three common literals plus any
 * `127.*` address (the whole 127/8 block is loopback); everything else —
 * `0.0.0.0`, `::` (the unspecified/all-interfaces wildcards), LAN IPs, and
 * hostnames — is treated as non-loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '127.0.0.1' || h === '::1' || h === 'localhost') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Refuse-to-boot guard. Throws an actionable error when the gateway would
 * bind off-loopback without a token; returns silently otherwise. Safe
 * combinations: loopback (token optional) or any host with a non-empty token.
 */
export function assertGatewaySafe(opts: { host: string; token: string | undefined }): void {
  const hasToken = typeof opts.token === 'string' && opts.token.length > 0;
  if (!isLoopbackHost(opts.host) && !hasToken) {
    throw new Error(
      `Refusing to start the gateway: host "${opts.host}" is not loopback and no auth token is set. Exposing the tool-running agent off-loopback without authentication is unsafe. Set a token via the SOV_GATEWAY_TOKEN environment variable or config.gateway.token, or bind to loopback (127.0.0.1) instead.`,
    );
  }
}
