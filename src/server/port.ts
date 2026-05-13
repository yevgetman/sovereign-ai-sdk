// Free-port discovery on 127.0.0.1.
//
// Bun.serve({ port: 0 }) asks the kernel for an ephemeral port; we read the
// assigned port back, stop the server, and return it. There is a microscopic
// race where another process could grab the port between stop() and the
// caller's bind, but for a local-only TUI launcher that's acceptable. The
// caller binds again on the same port immediately.

export async function findFreePort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(''),
  });
  const port = probe.port;
  probe.stop();
  if (typeof port !== 'number') {
    throw new Error('Bun.serve did not return a numeric port');
  }
  return port;
}
