// Phase A T6 — `sov gateway` long-lived entrypoint serving the native HTTP+SSE protocol with auth + CORS.

import type { AttestationManifest, ScopeOverlay } from '@yevgetman/decorum';
import { resolveHarnessHome } from '@yevgetman/sov-sdk/config/paths';
import { type Settings, SettingsSchema } from '@yevgetman/sov-sdk/config/schema';
import { readRawConfig } from '@yevgetman/sov-sdk/config/store';
import type { ConductProvider } from '@yevgetman/sov-sdk/core/conductPort';
import { createTurnEvidence, withEvidenceSink } from '../attestation/turnEvidence.js';
import { AttestationWriter } from '../attestation/writer.js';
import {
  type ChannelListeners,
  buildChannelListeners,
  resolveChannelsConfig,
} from '../channels/listeners.js';
import { createDecorumAdapter } from '../conduct/decorumAdapter.js';
import { assertGatewaySafe } from '../server/gatewaySafety.js';
import { startServer } from '../server/index.js';
import { buildRuntime } from '../server/runtime.js';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  SessionSupervisor,
} from '../server/sessionSupervisor.js';

const DEFAULT_GATEWAY_HOST = '127.0.0.1';
export const DEFAULT_GATEWAY_PORT = 8766;

/** Lowest / highest legal TCP port. A resolved gateway port outside this
 *  range (or non-integer) is rejected so Bun never silently binds a
 *  random/clamped port. Mirrors the bounds the schema enforces on
 *  `gateway.port` / `openaiServer.port`. */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Resolve + validate the gateway bind port.
 *
 * Precedence: `flag` > `env` > `configPort` > {@link DEFAULT_GATEWAY_PORT}.
 * An empty `env` string is treated as unset (falls through to config).
 *
 * The resolved value MUST be an integer in `[1, 65535]`. A non-numeric env
 * value (`parseInt` garbage like `'8080x'` or `'abc'`), `0`, a negative, or
 * anything `> 65535` throws a clear Error — the entrypoint prints it to
 * stderr and exits non-zero rather than letting Bun bind an unexpected port.
 *
 * `env` is parsed with `Number()` (NOT `parseInt`) so trailing garbage like
 * `'8080x'` is rejected rather than leniently truncated to `8080`.
 */
export function resolveGatewayPort(
  flag: number | undefined,
  env: string | undefined,
  configPort: number | undefined,
): number {
  const candidate = resolvePortCandidate(flag, env, configPort);
  if (!Number.isInteger(candidate) || candidate < MIN_PORT || candidate > MAX_PORT) {
    throw new Error(
      `invalid gateway port: ${JSON.stringify(candidate)} (must be an integer in [${MIN_PORT}, ${MAX_PORT}])`,
    );
  }
  return candidate;
}

/** Apply the precedence and coerce the chosen source to a number. The
 *  range/integer check lives in {@link resolveGatewayPort} so a single
 *  guard covers every source. Returns `NaN` for non-numeric env so the
 *  caller's `Number.isInteger` check rejects it (and the original string
 *  surfaces in the thrown message via the candidate value). */
function resolvePortCandidate(
  flag: number | undefined,
  env: string | undefined,
  configPort: number | undefined,
): number {
  if (flag !== undefined) return flag;
  if (env !== undefined && env.length > 0) {
    // Number('8080x') === NaN — strict, unlike Number.parseInt which would
    // leniently return 8080. NaN fails the integer/range check below.
    const parsed = Number(env);
    // Surface the offending raw string in the error rather than a bare NaN.
    if (Number.isNaN(parsed)) {
      throw new Error(
        `invalid gateway port: ${JSON.stringify(env)} (must be an integer in [${MIN_PORT}, ${MAX_PORT}])`,
      );
    }
    return parsed;
  }
  if (configPort !== undefined) return configPort;
  return DEFAULT_GATEWAY_PORT;
}

/**
 * Read the gateway config with env-FIRST channel-secret resolution.
 *
 * The F-T3 schema requires each enabled channel's secret(s) present in config and
 * stays env-free, so env resolution MUST happen before the schema parse. This
 * reads the RAW config, injects env-sourced secrets into `gateway.channels` (and
 * validates that every enabled channel now has its required secret(s) — throwing
 * a clear boot error naming the channel + the env var otherwise), splices the
 * merged channels back, then validates the whole object. Non-channel config is
 * untouched. The top-level main() catch prints any thrown error to stderr and
 * exits non-zero. Secrets are never logged.
 */
function readGatewayConfig(): Settings {
  const raw = readRawConfig();
  const gateway = raw.gateway;
  if (gateway !== undefined && gateway !== null && typeof gateway === 'object') {
    const gw = gateway as Record<string, unknown>;
    const resolvedChannels = resolveChannelsConfig(gw.channels, process.env);
    // Splice the env-merged channels back so SettingsSchema validates the merged
    // object (and the principalId binding) over the secrets that now exist.
    const mergedGateway =
      resolvedChannels !== undefined ? { ...gw, channels: resolvedChannels } : gw;
    return SettingsSchema.parse({ ...raw, gateway: mergedGateway });
  }
  return SettingsSchema.parse(raw);
}

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
  const config = readGatewayConfig();

  const host =
    opts.host ?? process.env.SOV_GATEWAY_HOST ?? config.gateway?.host ?? DEFAULT_GATEWAY_HOST;

  // Resolve + validate the bind port (precedence flag > env > config >
  // default). An out-of-range / non-numeric env or config value throws
  // here; the top-level main() catch prints it to stderr and exits 1
  // rather than letting Bun silently bind a random/clamped port.
  const port = resolveGatewayPort(opts.port, process.env.SOV_GATEWAY_PORT, config.gateway?.port);

  const rawToken = process.env.SOV_GATEWAY_TOKEN ?? config.gateway?.token;
  const trimmedToken = typeof rawToken === 'string' ? rawToken.trim() : undefined;
  const token = trimmedToken !== undefined && trimmedToken.length > 0 ? trimmedToken : undefined;

  // Phase E — per-principal auth. Mutually exclusive with the single token
  // (the config superRefine enforces it); when a non-empty registry is
  // present the gateway runs in principals mode and `token` is not passed.
  const principals =
    config.gateway?.principals !== undefined && config.gateway.principals.length > 0
      ? config.gateway.principals
      : undefined;

  const corsOrigins = config.gateway?.corsOrigins;

  // Refuse-to-boot guard. Off-loopback without ANY auth is fatal; print the
  // actionable message (never the token) and exit non-zero. A configured
  // principals registry is auth too, so it satisfies the guard the same way a
  // single token does — pass a non-empty sentinel (the guard only inspects
  // presence, never the value, and the principals' tokens are never logged).
  const authSentinel = token ?? (principals !== undefined ? 'principals' : undefined);
  try {
    assertGatewaySafe({ host, token: authSentinel });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sov gateway: ${msg}\n`);
    process.exit(1);
  }

  // Conduct Port (spec D30) — when a `conduct` block is configured, build the
  // decorum adapter and bind it as the runtime's ConductProvider. The adapter
  // FAILS CLOSED at boot (throws on a missing/invalid pack); the top-level
  // main() catch prints it to stderr and exits non-zero rather than booting a
  // gateway into a no-governance state. ABSENT block ⇒ `conduct` stays
  // undefined and every seam runs as the null provider (byte-identical).
  // The audit inlet is late-bound: the adapter is constructed BEFORE the runtime
  // exists, so it captures a `let runtime` that is assigned immediately after
  // `buildRuntime`. The closure only fires during turns — long after boot — so
  // `runtime` is always populated by the time an audit event flows through it.
  let runtime: Awaited<ReturnType<typeof buildRuntime>> | undefined;
  const conductAuditEnabled = config.observability?.conductAudit !== false; // default on

  // Attestation evidence (spec 2026-07-19 §3.1/§3.2/§3.4) — OPT-IN via
  // `conduct.attestation.enabled` (the schema superRefine already rejected an
  // enabled block with no pack bound). The writer is constructed BEFORE the
  // adapter so its records sink can ride into `createDecorumProvider`; the
  // manifest getter is LATE-BOUND (the same idiom as the audit inlet's
  // `runtime` above) to the post-overlay provider assigned right after the
  // adapter returns — the SAME instance whose hooks run, so an overlay-scoped
  // deployment snapshots its scoped hash, and a hot-reload recomposition reads
  // fresh through the getter (§3.2). ABSENT block ⇒ no writer, no evidence
  // coordinator, no wrapper — byte-identical. A bad `dir` (absolute / escaping
  // HARNESS_HOME) throws HERE at construction: a boot-time config error, like
  // a bad pack path. The warn channel is stderr — the per-session trace route
  // is peek-only and a writer failure has no session to land in; stderr is the
  // gateway's always-on operator channel (the writer keeps counting every
  // subsequent failure in `failureCount`).
  const attestationConfig = config.conduct?.attestation;
  let attestedProvider:
    | (ConductProvider & { readonly attestationManifest: AttestationManifest })
    | undefined;
  const attestationWriter =
    attestationConfig?.enabled === true
      ? new AttestationWriter({
          harnessHome,
          dir: attestationConfig.dir,
          getManifest: () => {
            if (attestedProvider === undefined) {
              throw new Error('conduct provider not bound yet');
            }
            return attestedProvider.attestationManifest;
          },
          warn: (message) => process.stderr.write(`sov gateway: ${message}\n`),
        })
      : undefined;

  // The adapter now returns the provider PLUS the overlay intake result (present
  // only when `conduct.overlay` was supplied). The intake is content-free —
  // counts + reason codes — and is served at GET /conduct/overlay so the host can
  // tell a user their directive was refused rather than silently dropped.
  const conductBinding =
    config.conduct !== undefined
      ? createDecorumAdapter({
          ...(config.conduct.configPath !== undefined
            ? { configPath: config.conduct.configPath }
            : {}),
          ...(config.conduct.packDir !== undefined ? { packDir: config.conduct.packDir } : {}),
          ...(config.conduct.overlay !== undefined
            ? { overlay: config.conduct.overlay as ScopeOverlay }
            : {}),
          ...(conductAuditEnabled
            ? {
                emitExternalTrace: (sessionId: string, event) =>
                  runtime?.recordExternalTrace(sessionId, event),
              }
            : {}),
          // Attestation §3.1 — the records sink, forwarded into
          // createDecorumProvider exactly as auditSink is. Fire-and-forget:
          // the writer never throws into decorum, and decorum's observation
          // seam fails open anyway.
          ...(attestationWriter !== undefined
            ? { attestationSink: (record) => attestationWriter.record(record) }
            : {}),
        })
      : undefined;
  const baseConduct = conductBinding?.provider;
  const overlayIntake = conductBinding?.intake;

  // Attestation §3.2/§3.4 — bind the manifest getter to THE SAME provider
  // instance the runtime mounts (post-overlay: `conductBinding.provider` IS the
  // scoped provider when an overlay was folded, so a scoped deployment
  // snapshots its scoped hash), take the boot-time manifest snapshot, and
  // build the io evidence coordinator. decorum's base and scoped providers
  // both carry the `attestationManifest` getter at runtime (provider.ts
  // documents the superset); a provider WITHOUT it cannot attest, so refuse
  // to boot rather than run evidence-blind (fail-fast, like a bad pack path).
  let attestationEvidence: ReturnType<typeof createTurnEvidence> | undefined;
  let conduct = baseConduct;
  if (attestationWriter !== undefined && baseConduct !== undefined) {
    const capable = baseConduct as ConductProvider & {
      readonly attestationManifest?: AttestationManifest;
    };
    if (capable.attestationManifest === undefined) {
      throw new Error(
        'conduct.attestation is enabled but the bound conduct provider exposes no attestation manifest — evidence cannot be collected (decorum >= 0.10 required)',
      );
    }
    attestedProvider = capable as ConductProvider & {
      readonly attestationManifest: AttestationManifest;
    };
    attestationWriter.snapshotManifest();
    attestationEvidence = createTurnEvidence({
      writer: attestationWriter,
      io: attestationConfig?.io === true,
    });
    // io mode mounts the evidenceSink wrapper (observed-turn capture at the
    // SDK's onFinal seam); records-only mode mounts the provider UNWRAPPED —
    // no turn text is ever captured without the deliberate `io: true`.
    if (attestationEvidence.evidenceSink !== undefined) {
      conduct = withEvidenceSink(baseConduct, attestationEvidence.evidenceSink);
    }
  }

  runtime = await buildRuntime({
    cwd: process.cwd(),
    harnessHome,
    ...(conduct !== undefined ? { conduct } : {}),
    ...(attestationEvidence !== undefined ? { attestationEvidence } : {}),
  });

  // Phase D — gateway-scoped session lifecycle. The SessionSupervisor sweeps
  // idle in-memory session state (context + bus) on a cadence and surfaces the
  // concurrency cap POST /sessions enforces. It is constructed ONLY here so the
  // TUI / `sov drive` / `sov serve` paths (which never run a long-lived
  // multi-client gateway) stay untouched. Undefined config fields fall through
  // to the supervisor's own defaults; `maxConcurrentSessions` defaults to 0
  // (unlimited) so an unconfigured gateway behaves as before.
  const supervisor = new SessionSupervisor({
    runtime,
    // Conditional spread: under exactOptionalPropertyTypes an explicit
    // `undefined` is not assignable to an optional `number`. Omit the key when
    // unset so the supervisor applies its own default.
    ...(config.gateway?.idleSessionTimeoutMs !== undefined
      ? { idleSessionTimeoutMs: config.gateway.idleSessionTimeoutMs }
      : {}),
    ...(config.gateway?.idleSweepIntervalMs !== undefined
      ? { idleSweepIntervalMs: config.gateway.idleSweepIntervalMs }
      : {}),
    maxConcurrentSessions: config.gateway?.maxConcurrentSessions ?? 0,
  });
  supervisor.start();

  // Phase F — inbound channels. The webhook + Slack channels are HTTP routes
  // (mounted by buildAppWithRuntime when `channels` is passed below); Telegram
  // long-polls, so it's a background worker. Secrets were already env-resolved +
  // boot-validated in readGatewayConfig(), so `config.gateway.channels` carries
  // them. Construct + start the listeners AFTER the supervisor (mirrors the cron
  // runner's start-after-deps ordering) and BEFORE the server so the poll loop is
  // live the moment the gateway accepts traffic.
  const channels = config.gateway?.channels;
  let listeners: ChannelListeners | undefined;
  if (channels !== undefined) {
    listeners = buildChannelListeners(runtime, channels);
    listeners.start();
  }

  // Principals and the single token are mutually exclusive (config-enforced):
  // pass principals when present, otherwise the single token, otherwise neither
  // (open loopback). Never pass both. `channels` is forwarded so the OPEN
  // webhook + Slack routes mount (each authenticates via its own transport
  // credential, not the gateway token); absent ⇒ no channel route is mounted.
  const server = await startServer({
    runtime,
    hostname: host,
    port,
    supervisor,
    ...(principals !== undefined ? { principals } : token !== undefined ? { auth: token } : {}),
    ...(corsOrigins !== undefined ? { corsOrigins } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(overlayIntake !== undefined ? { overlayIntake } : {}),
  });

  process.stdout.write(`sov gateway: listening on http://${host}:${server.port}\n`);
  process.stdout.write(
    `  provider=${runtime.resolvedProvider.transport.name}  model=${runtime.model}\n`,
  );
  const authMode =
    principals !== undefined
      ? `principals(${principals.length})`
      : token !== undefined
        ? 'on'
        : 'off';
  process.stdout.write(
    `  auth=${authMode}  cors=${corsOrigins?.length ? 'on' : 'off'}  harnessHome=${harnessHome}\n`,
  );
  // Summarize the session-lifecycle policy using the EFFECTIVE values (config
  // overrides falling back to the supervisor's own defaults).
  const idleMs = config.gateway?.idleSessionTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sweepMs = config.gateway?.idleSweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const maxSessions = supervisor.getMaxConcurrentSessions() ?? 0;
  process.stdout.write(
    `  idle-evict: reclaim sessions idle >${Math.round(idleMs / 60000)}m every ${Math.round(sweepMs / 60000)}m; max-sessions: ${maxSessions || 'unlimited'}\n`,
  );
  // One-line channels summary — the ENABLED channel names only, NEVER the
  // secrets. Omitted entirely when no channel is enabled.
  if (channels !== undefined) {
    const enabledNames = (['webhook', 'telegram', 'slack', 'sms'] as const).filter(
      (name) => channels[name]?.enabled === true,
    );
    if (enabledNames.length > 0) {
      process.stdout.write(`  channels: ${enabledNames.join(', ')}\n`);
    }
  }

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
    // Disarm the idle sweep BEFORE runtime.dispose() so an in-flight sweep can
    // never race sessionDb.close() (same ordering rule the cron runner follows:
    // stop the periodic worker, then tear down the DB it touches). stop() is
    // idempotent, awaits any in-flight sweep (draining it before the DB is
    // closed), and swallows its errors; this shutdown path runs once (guarded
    // by `shuttingDown`) for whichever of SIGINT / SIGTERM fires first.
    await supervisor.stop();
    // Halt the channel background workers (Telegram poll loop) BEFORE
    // runtime.dispose() so an in-flight poll can never race the DB close — same
    // stop-the-worker-then-tear-down-the-DB ordering as the supervisor / cron
    // runner above. stop() is idempotent.
    try {
      await listeners?.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`channel listeners stop() failed: ${msg}\n`);
    }
    try {
      await runtime.dispose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`runtime.dispose() failed: ${msg}\n`);
    }
    // Drain the attestation evidence queue LAST — the server + workers are
    // stopped, so every turn's records/io lines are already enqueued; close()
    // awaits the sequential write chain so the final lines land before exit.
    // Fails open like every evidence path.
    try {
      await attestationWriter?.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`attestation writer close() failed: ${msg}\n`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Park forever — the SIGINT/SIGTERM handlers above are the only legal
  // exit paths.
  await new Promise<never>(() => {});
}
