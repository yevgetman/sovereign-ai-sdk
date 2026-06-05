// Phase A T6 — `sov gateway` long-lived entrypoint serving the native HTTP+SSE protocol with auth + CORS.

import { resolveHarnessHome } from '../config/paths.js';
import { readConfig } from '../config/store.js';
import { assertGatewaySafe } from '../server/gatewaySafety.js';
import { startServer } from '../server/index.js';
import { buildRuntime } from '../server/runtime.js';

const DEFAULT_GATEWAY_HOST = '127.0.0.1';
const DEFAULT_GATEWAY_PORT = 8766;

/**
 * Boot the native HTTP+SSE gateway. Resolution precedence:
 *   host  = opts.host  > SOV_GATEWAY_HOST  > config.gateway.host  > 127.0.0.1
 *   port  = opts.port  > SOV_GATEWAY_PORT  > config.gateway.port  > 8766
 *   token = SOV_GATEWAY_TOKEN > config.gateway.token (trimmed; empty → none)
 *   corsOrigins = config.gateway.corsOrigins
 *
 * Refuses to boot (exit 1) when the bind host is off-loopback without a
 * token. Mirrors the `sov serve` lifecycle: graceful SIGINT/SIGTERM
 * shutdown (server.stop() + runtime.dispose()) then park forever. The
 * token is never logged or printed.
 */
export async function runGateway(opts: { host?: string; port?: number }): Promise<void> {
  const harnessHome = resolveHarnessHome();
  const config = readConfig();

  const host =
    opts.host ?? process.env.SOV_GATEWAY_HOST ?? config.gateway?.host ?? DEFAULT_GATEWAY_HOST;

  const envPortRaw = process.env.SOV_GATEWAY_PORT;
  const envPort =
    envPortRaw !== undefined && envPortRaw.length > 0 ? Number.parseInt(envPortRaw, 10) : undefined;
  const port =
    opts.port ??
    (envPort !== undefined && Number.isFinite(envPort) ? envPort : undefined) ??
    config.gateway?.port ??
    DEFAULT_GATEWAY_PORT;

  const rawToken = process.env.SOV_GATEWAY_TOKEN ?? config.gateway?.token;
  const trimmedToken = typeof rawToken === 'string' ? rawToken.trim() : undefined;
  const token = trimmedToken !== undefined && trimmedToken.length > 0 ? trimmedToken : undefined;

  const corsOrigins = config.gateway?.corsOrigins;

  // Refuse-to-boot guard. Off-loopback without a token is fatal; print the
  // actionable message (never the token) and exit non-zero.
  try {
    assertGatewaySafe({ host, token });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sov gateway: ${msg}\n`);
    process.exit(1);
  }

  const runtime = await buildRuntime({
    cwd: process.cwd(),
    harnessHome,
  });

  const server = await startServer({
    runtime,
    hostname: host,
    port,
    ...(token !== undefined ? { auth: token } : {}),
    ...(corsOrigins !== undefined ? { corsOrigins } : {}),
  });

  process.stdout.write(`sov gateway: listening on http://${host}:${server.port}\n`);
  process.stdout.write(
    `  provider=${runtime.resolvedProvider.transport.name}  model=${runtime.model}\n`,
  );
  process.stdout.write(
    `  auth=${token !== undefined ? 'on' : 'off'}  cors=${corsOrigins?.length ? 'on' : 'off'}  harnessHome=${harnessHome}\n`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`sov gateway: ${signal} received, shutting down...\n`);
    try {
      await server.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`server.stop() failed: ${msg}\n`);
    }
    try {
      await runtime.dispose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`runtime.dispose() failed: ${msg}\n`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Park forever — the SIGINT/SIGTERM handlers above are the only legal
  // exit paths.
  await new Promise<never>(() => {});
}
