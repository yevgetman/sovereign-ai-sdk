// Phase F-T7 — wire the channel adapters into the gateway lifecycle.
//
// Two concerns live here:
//
//   1. resolveChannelsConfig(rawChannels, env) — env-FIRST secret resolution over
//      the RAW (pre-parse) gateway.channels object. The F-T3 schema requires each
//      enabled channel's secret(s) present IN CONFIG and stays pure / env-free; so
//      env resolution must happen BEFORE the parse. This fills any missing secret
//      field from its env var, then validates presence on ENABLED channels — an
//      enabled channel with NEITHER a config secret NOR an env secret throws a
//      clear boot error naming the channel + the field + its env var (rather than
//      letting the raw Zod issue surface). The returned merged object is then
//      re-parsed by SettingsSchema, which validates structure + the principalId
//      binding. Disabled / enabled-omitted channels are left untouched.
//
//   2. buildChannelListeners(runtime, channels, deps?) — the holder for channel
//      BACKGROUND WORKERS. Webhook + Slack are inbound HTTP routes (mounted by the
//      gateway app, not workers); Telegram has no public endpoint and instead
//      long-polls, so it IS a background worker. Today this builds the Telegram
//      poll loop when telegram is enabled; it's kept as the general
//      "channel workers" holder so future poll-based channels slot in here.
//
// SECURITY: secrets (bot tokens, signing/webhook secrets) are NEVER logged — not
// by the env merge, not by the boot validator (its message names the env VAR, not
// the value), not by the listener.

import type { Runtime } from '../server/runtime.js';
import { type TelegramTransport, createTelegramListener } from './adapters/telegram.js';

/** Env var names that supply a channel secret when the config field is absent.
 *  Defined here so the merge + the boot-error message + the docs share one source
 *  of truth. */
export const CHANNEL_SECRET_ENV = {
  telegram: { botToken: 'SOV_TELEGRAM_BOT_TOKEN' },
  slack: { signingSecret: 'SOV_SLACK_SIGNING_SECRET', botToken: 'SOV_SLACK_BOT_TOKEN' },
  webhook: { secret: 'SOV_WEBHOOK_SECRET' },
} as const;

/** The minimal env shape this module reads. A subset of `process.env` so it's
 *  injectable in tests. Values are the raw strings (or undefined when unset). */
export type ChannelEnv = Record<string, string | undefined>;

/** The parsed telegram channel shape buildChannelListeners consumes (structural
 *  subset of Settings['gateway']['channels']['telegram'] — kept local so this
 *  module stays decoupled from the Zod schema, mirroring routes/channels.ts). */
export type TelegramChannelConfig = {
  enabled?: boolean | undefined;
  botToken?: string | undefined;
  principalId: string;
  permissionMode?: 'default' | 'ask' | undefined;
};

/** The full parsed channels block (webhook + slack are HTTP routes; telegram is
 *  the poll-loop worker built here). Mirrors the parsed schema shape but stays a
 *  local structural type so this module is schema-decoupled. Only `telegram` is
 *  read here; webhook / slack are accepted for shape-compatibility with the
 *  parsed config (and ignored — their routes are mounted by the gateway app). */
export type ChannelListenersConfig = {
  webhook?:
    | { enabled?: boolean | undefined; secret?: string | undefined; principalId?: string }
    | undefined;
  slack?:
    | {
        enabled?: boolean | undefined;
        signingSecret?: string | undefined;
        botToken?: string | undefined;
        principalId?: string;
      }
    | undefined;
  telegram?: TelegramChannelConfig | undefined;
};

/** Injectable seams for the listeners (tests). Production omits all of them and
 *  the listeners construct their own real transports from the resolved secrets. */
export type ChannelListenersDeps = {
  /** Inject a Telegram transport (tests). Omitted ⇒ the real fetch Bot API
   *  client built from the resolved bot token. */
  telegramTransport?: TelegramTransport | undefined;
  /** Override the Telegram poll cadence (ms). Omitted ⇒ the adapter default. */
  pollIntervalMs?: number | undefined;
};

/** The background-workers handle. start() arms every enabled channel's worker;
 *  stop() halts them. Mirrors the SessionSupervisor / cron-runner start/stop
 *  contract so the gateway lifecycle treats it the same way. */
export type ChannelListeners = {
  start(): void;
  stop(): Promise<void> | void;
};

const CHANNEL_NAMES = ['webhook', 'telegram', 'slack'] as const;
type ChannelName = (typeof CHANNEL_NAMES)[number];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Merge env-sourced secrets into the RAW (pre-parse) gateway.channels object and
 * validate that every enabled channel has its required secret(s).
 *
 * Precedence: a secret present in config WINS over the env var (the env only
 * fills an ABSENT field). Disabled / enabled-omitted channels are left exactly as
 * given — no env injection, no presence check. An enabled channel missing a
 * required secret in BOTH config and env throws a clear boot error naming the
 * channel + the field + the env var.
 *
 * Pure: never mutates `rawChannels`; returns a fresh deep-ish copy with the
 * secrets merged in. `rawChannels` is `unknown` because this runs on the raw
 * JSON BEFORE the schema parse.
 */
export function resolveChannelsConfig(
  rawChannels: unknown,
  env: ChannelEnv,
): Record<string, unknown> | undefined {
  if (rawChannels === undefined) return undefined;
  if (!isPlainObject(rawChannels)) {
    // Let the schema parse report the structural error precisely; we only pass
    // it through unchanged here.
    return rawChannels as Record<string, unknown>;
  }

  const out: Record<string, unknown> = {};
  for (const name of CHANNEL_NAMES) {
    const channel = rawChannels[name];
    if (channel === undefined) continue;
    out[name] = mergeChannelSecrets(name, channel, env);
  }
  // Preserve any unexpected keys verbatim so the schema's .strict() can reject
  // them (rather than this merge silently dropping them).
  for (const [key, value] of Object.entries(rawChannels)) {
    if (!(CHANNEL_NAMES as readonly string[]).includes(key)) out[key] = value;
  }
  return out;
}

/** Merge env secrets into one channel object (immutably) and, if it's enabled,
 *  assert each required secret is now present. */
function mergeChannelSecrets(name: ChannelName, channel: unknown, env: ChannelEnv): unknown {
  if (!isPlainObject(channel)) return channel;
  const secretFields = CHANNEL_SECRET_ENV[name];
  const merged: Record<string, unknown> = { ...channel };
  const enabled = channel.enabled === true;

  for (const [field, envVar] of Object.entries(secretFields)) {
    const fromConfig = merged[field];
    if (typeof fromConfig === 'string' && fromConfig.length > 0) {
      // Config wins — leave it.
      continue;
    }
    if (merged[field] === undefined || merged[field] === '') {
      const fromEnv = env[envVar];
      // Only inject for enabled channels — a disabled channel is never validated
      // and must stay byte-identical to its config form.
      if (enabled && typeof fromEnv === 'string' && fromEnv.length > 0) {
        merged[field] = fromEnv;
      }
    }
  }

  if (enabled) {
    for (const [field, envVar] of Object.entries(secretFields)) {
      const value = merged[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(
          `gateway.channels.${name} is enabled but ${field} is missing — set ` +
            `gateway.channels.${name}.${field} in config or the ${envVar} env var`,
        );
      }
    }
  }

  return merged;
}

/**
 * Build the channel background-workers handle for the gateway lifecycle.
 *
 * Today the only worker is the Telegram poll loop (webhook + Slack are inbound
 * HTTP routes, mounted by the gateway app — they need no worker). When telegram
 * is enabled, a {@link createTelegramListener} is constructed with the resolved
 * bot token + principal (+ an injected transport / poll cadence from `deps` for
 * tests). When telegram is absent / disabled, the handle is an inert no-op so the
 * gateway can always call start()/stop() unconditionally.
 *
 * `channels` is the PARSED + env-resolved config (secrets already present). The
 * returned handle's start() arms each worker; stop() halts each.
 */
export function buildChannelListeners(
  runtime: Runtime,
  channels: ChannelListenersConfig,
  deps: ChannelListenersDeps = {},
): ChannelListeners {
  const workers: Array<{ start(): void; stop(): void }> = [];

  const telegram = channels.telegram;
  if (telegram?.enabled === true) {
    // botToken is guaranteed present by resolveChannelsConfig (boot-validated);
    // fall back to '' defensively so a mis-wired caller fails at the transport,
    // never with a confusing undefined interpolation.
    const listener = createTelegramListener({
      runtime,
      botToken: telegram.botToken ?? '',
      principalId: telegram.principalId,
      ...(telegram.permissionMode !== undefined ? { permissionMode: telegram.permissionMode } : {}),
      ...(deps.telegramTransport !== undefined ? { transport: deps.telegramTransport } : {}),
      ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    });
    workers.push(listener);
  }

  return {
    start(): void {
      for (const w of workers) w.start();
    },
    stop(): void {
      for (const w of workers) w.stop();
    },
  };
}
