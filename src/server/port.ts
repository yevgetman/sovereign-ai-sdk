// Free-port discovery + bind-host resolution for the native HTTP+SSE server.
//
// Bun.serve({ port: 0 }) asks the kernel for an ephemeral port; we read the
// assigned port back, stop the server, and return it. There is a microscopic
// race where another process could grab the port between stop() and the
// caller's bind, but for a local-only TUI launcher that's acceptable. The
// caller binds again on the same port immediately.

/** The loopback host the native server has always bound. Every surface
 *  (TUI launcher, `sov serve`, `sov drive`) keeps this default; only the
 *  later `sov gateway` opts into a non-loopback bind. */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * Pure resolution of the bind host: an explicit value wins, otherwise we
 * fall back to loopback. Extracted as a seam so the gateway's off-loopback
 * decision is unit-testable without actually binding a non-loopback socket.
 */
export function resolveBindHost(explicit?: string): string {
  return explicit ?? DEFAULT_BIND_HOST;
}

export async function findFreePort(hostname?: string): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: resolveBindHost(hostname),
    fetch: () => new Response(''),
  });
  const port = probe.port;
  probe.stop();
  if (typeof port !== 'number') {
    throw new Error(`Bun.serve returned non-numeric port: ${typeof port} ${String(port)}`);
  }
  return port;
}
