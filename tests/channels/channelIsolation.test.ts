// Phase F-T8 — channel isolation + security PROPERTY suite.
//
// Channels are an UNTRUSTED REMOTE RCE surface: a Slack message, a Telegram DM,
// or a webhook POST drives a real harness turn. The per-task harnesses
// (webhook/slack/telegram/pipeline) already pin each piece's mechanics; THIS
// suite proves the load-bearing SECURITY PROPERTIES end-to-end, and these become
// the regression guards the 8b adversarial review checks. Each property is
// proved by an OBSERVABLE consequence — an on-disk namespace, a sentinel file
// that was (not) written, a status code, a row that does (not) exist — never by
// asserting an implementation detail.
//
// The six property groups:
//   1. Per-channel principal isolation — two channels bound to DIFFERENT
//      principals land their memory + learning under disjoint users/{id}/…
//      namespaces; neither sees the other's content nor a human principal's.
//   2. Conservative permission posture (the crux) — a channel turn that scripts
//      Bash (and Write) is DENIED even with an on-disk `allow Bash(*)` /
//      `allow Write(*)` rule seeded in settings.local.json. Channels do NOT
//      inherit local dev allow-rules. Proved by the sentinel file's absence,
//      with a control proving loadPermissionSettings DOES see that allow rule.
//   3. Inbound auth is enforced — a bad/missing webhook HMAC → 401 + no turn;
//      a bad Slack signature → 403 + no turn; a stale Slack timestamp → 403 +
//      no turn. Proved by the status code AND the absent session row / absent
//      learning namespace (no side-effect ran).
//   4. `bypass` is rejected — config with permissionMode:'bypass' fails to
//      parse (schema enum) AND assertChannelPermissionMode('bypass') throws.
//   5. No cross-principal escalation via the API — a channel principal that
//      also holds a gateway bearer token is a NORMAL Phase-E principal: it
//      cannot read another principal's sessions through /sessions/* (404), and
//      the channel-created session is owner-scoped (not listable by another).
//   6. Secrets aren't echoed — a bad-auth rejection body never contains the
//      configured webhook secret / Slack signing secret / bot token.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsSchema } from '@yevgetman/sov-sdk/config/schema';
import { loadPermissionSettings } from '@yevgetman/sov-sdk/config/settings';
import { replaceMemoryFile } from '@yevgetman/sov-sdk/memory/bounded';
import { MockProvider } from '@yevgetman/sov-sdk/providers/mock';
import type { SlackTransport } from '../../src/channels/adapters/slack.js';
import { assertChannelPermissionMode } from '../../src/channels/permission.js';
import { buildSessionKey } from '../../src/channels/sessionKey.js';
import { observationsPath } from '../../src/learning/paths.js';
import { __test_resetProjectIdCache, getProjectId } from '../../src/learning/project.js';
import { buildAppWithRuntime } from '../../src/server/app.js';
import { __test_resetAllBuses } from '../../src/server/eventBus.js';
import type { ChannelsConfig, ChannelsDeps } from '../../src/server/routes/channels.js';
import { buildRuntime } from '../../src/server/runtime.js';
import type { Runtime } from '../../src/server/runtime.js';

// --- principals + secrets ----------------------------------------------------

const WEBHOOK_PRINCIPAL = 'wh';
const SLACK_PRINCIPAL = 'sk';
const HUMAN_PRINCIPAL = 'human'; // a normal interactive gateway user
const WEBHOOK_SECRET = 'whsec_isolation';
const SLACK_SIGNING_SECRET = 'slacksec_isolation';
const SLACK_BOT_TOKEN = 'xoxb-isolation-never-logged';
const WEBHOOK_ID = 'default';

const HUMAN_TOKEN = 'tok-human';
const WEBHOOK_PRINCIPAL_TOKEN = 'tok-wh';

const JSON_HEADER = { 'Content-Type': 'application/json' };

// --- signing helpers ---------------------------------------------------------

/** `sha256=<hmac-sha256(secret, raw)>` — the webhook signature header. */
function signWebhook(raw: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

/** `v0=<hmac-sha256(secret, v0:ts:raw)>` — the Slack signature header. */
function signSlack(raw: string, ts: string, secret: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
}

function nowSecs(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** Build a Slack message-event body whose parsed InboundMessage keys on
 *  sender=`user`, chatId=`channel`. */
function slackEventBody(opts: { user: string; channel: string; text: string }): string {
  return JSON.stringify({
    type: 'event_callback',
    event_id: `Ev-${opts.channel}-${Date.now()}`,
    event: {
      type: 'message',
      user: opts.user,
      channel: opts.channel,
      text: opts.text,
      channel_type: 'channel',
    },
  });
}

// --- MockProvider statics ----------------------------------------------------

function resetMockProviderStatics(): void {
  MockProvider.toolUseMode = false;
  MockProvider.stallMode = false;
  MockProvider.toolUseScript = undefined;
  MockProvider.resetScriptCursor();
  MockProvider.lastMessages = undefined;
  MockProvider.lastMaxTokens = undefined;
  MockProvider.lastSignal = undefined;
  MockProvider.throwOnNext = undefined;
  MockProvider.streamCalls = 0;
}

/** A two-step scripted turn: the model dispatches one Bash call (→ a learning
 *  observation is recorded for the dispatched tool, regardless of whether the
 *  call is permitted) then ends with text. The Bash command writes a sentinel
 *  so the posture tests can assert it never executed under the channel decider. */
function bashThenDoneScript(sentinel: string): void {
  MockProvider.toolUseScript = [
    { kind: 'tool_use', name: 'Bash', input: { command: `touch ${sentinel}` }, id: 'ci-bash-0' },
    { kind: 'text', text: 'done.' },
  ];
  MockProvider.resetScriptCursor();
}

// --- transport seam + background collector (Slack) ---------------------------

function makeMockSlackTransport(): {
  transport: SlackTransport;
  posted: Array<{ channel: string; text: string }>;
} {
  const posted: Array<{ channel: string; text: string }> = [];
  return {
    transport: {
      async postMessage(channel: string, text: string): Promise<void> {
        posted.push({ channel, text });
      },
    },
    posted,
  };
}

function makeBackgroundCollector(): {
  onBackgroundTask: (p: Promise<void>) => void;
  drain: () => Promise<void>;
} {
  const inflight: Array<Promise<void>> = [];
  return {
    onBackgroundTask: (p) => {
      inflight.push(p);
    },
    drain: async () => {
      await Promise.all(inflight.splice(0));
    },
  };
}

// --- runtime boot ------------------------------------------------------------

async function buildTestRuntime(home: string): Promise<Runtime> {
  return buildRuntime({
    cwd: home,
    harnessHome: home,
    provider: 'mock',
    model: 'mock-haiku',
    preflight: false,
    cronEnabled: false,
  });
}

describe('Phase F-T8 — channel isolation + security properties', () => {
  let home: string;
  let runtime: Runtime;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'sov-chan-isolation-'));
    process.env.SOV_TEST_MOCK_PROVIDER = '1';
    // Pin HARNESS_HOME so buildRuntime's sessions.db is isolated per test — the
    // DETERMINISTIC channel session key (agent:main:<channel>:…) would otherwise
    // collide across tests + dev runs that share ~/.harness/sessions.db.
    process.env.HARNESS_HOME = home;
    resetMockProviderStatics();
    __test_resetAllBuses();
    // getProjectId is cwd-keyed + process-cached; home is fresh each test, but
    // reset defensively so a prior resolution can never bleed in.
    __test_resetProjectIdCache();
    runtime = await buildTestRuntime(home);
  });

  afterEach(async () => {
    await runtime.dispose();
    resetMockProviderStatics();
    __test_resetAllBuses();
    __test_resetProjectIdCache();
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.SOV_TEST_MOCK_PROVIDER;
    // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
    delete process.env.HARNESS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  // ===========================================================================
  // 1. Per-channel principal isolation
  // ===========================================================================
  //
  // Two channels (webhook→wh, slack→sk) drive turns under DIFFERENT principals.
  // Each turn writes a learning observation (the scripted Bash dispatch) which
  // lands under that principal's users/{id}/learning namespace, and reads memory
  // from that principal's users/{id}/memory namespace. We assert the on-disk
  // namespaces are disjoint and that neither sees the other — nor a human user
  // principal's — content. This reuses the Phase-E on-disk path observable.

  test('learning lands under disjoint users/{principal} namespaces; neither leaks', async () => {
    const deps: ChannelsDeps & {
      onBackgroundTask: (p: Promise<void>) => void;
      drain: () => Promise<void>;
    } = (() => {
      const { transport } = makeMockSlackTransport();
      const bg = makeBackgroundCollector();
      return { slackTransport: transport, ...bg };
    })();
    const channels: ChannelsConfig = {
      webhook: { enabled: true, secret: WEBHOOK_SECRET, principalId: WEBHOOK_PRINCIPAL },
      slack: {
        enabled: true,
        signingSecret: SLACK_SIGNING_SECRET,
        botToken: SLACK_BOT_TOKEN,
        principalId: SLACK_PRINCIPAL,
      },
    };
    const app = buildAppWithRuntime(runtime, { channels }, deps);

    // Drive the webhook channel (principal wh) with a Bash-dispatching turn.
    bashThenDoneScript(join(home, 'wh-sentinel.txt'));
    const whRaw = JSON.stringify({ sender: 'wh-user', text: 'run', chatId: 'wh-chat' });
    const whRes = await app.request(`/channels/webhook/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': signWebhook(whRaw, WEBHOOK_SECRET) },
      body: whRaw,
    });
    expect(whRes.status).toBe(200);
    // Flush the webhook session's async observer write chain.
    await runtime.disposeSession(
      buildSessionKey({
        channel: 'webhook',
        sender: 'wh-user',
        chatId: 'wh-chat',
        chatType: 'private',
        text: 'run',
      }),
    );

    // Drive the slack channel (principal sk) with its own Bash-dispatching turn.
    bashThenDoneScript(join(home, 'sk-sentinel.txt'));
    const ts = nowSecs();
    const skRaw = slackEventBody({ user: 'sk-user', channel: 'C-sk', text: 'run' });
    const skRes = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        ...JSON_HEADER,
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': signSlack(skRaw, ts, SLACK_SIGNING_SECRET),
      },
      body: skRaw,
    });
    expect(skRes.status).toBe(200);
    await deps.drain();
    await runtime.disposeSession(
      buildSessionKey({
        channel: 'slack',
        sender: 'sk-user',
        chatId: 'C-sk',
        chatType: 'channel',
        text: 'run',
      }),
    );

    const projectId = getProjectId(home).id;
    const whObs = observationsPath(home, projectId, WEBHOOK_PRINCIPAL);
    const skObs = observationsPath(home, projectId, SLACK_PRINCIPAL);
    const legacyObs = observationsPath(home, projectId); // no userId
    const humanObs = observationsPath(home, projectId, HUMAN_PRINCIPAL);

    // Each channel's observation landed strictly under its OWN principal corpus.
    expect(existsSync(whObs)).toBe(true);
    expect(existsSync(skObs)).toBe(true);
    expect(readFileSync(whObs, 'utf8')).toContain('"tool_name":"Bash"');
    expect(readFileSync(skObs, 'utf8')).toContain('"tool_name":"Bash"');

    // The two corpora are different files (disjoint namespaces).
    expect(whObs).not.toBe(skObs);

    // Nothing leaked into the legacy top-level corpus or an uninvolved human
    // principal's namespace.
    expect(existsSync(legacyObs)).toBe(false);
    expect(existsSync(humanObs)).toBe(false);
    expect(existsSync(join(home, 'learning', projectId))).toBe(false);
    expect(existsSync(join(home, 'users', HUMAN_PRINCIPAL))).toBe(false);
  });

  test('memory is read from each channel principal namespace only; no cross-read', async () => {
    // Seed a DISTINCTIVE MEMORY.md per namespace BEFORE any turn so the
    // per-session memory manager (built on first getSessionContext) reads it.
    replaceMemoryFile('MEMORY.md', 'WH-SECRET-MEMORY', home, WEBHOOK_PRINCIPAL);
    replaceMemoryFile('MEMORY.md', 'SK-SECRET-MEMORY', home, SLACK_PRINCIPAL);
    replaceMemoryFile('MEMORY.md', 'HUMAN-SECRET-MEMORY', home, HUMAN_PRINCIPAL);
    replaceMemoryFile('MEMORY.md', 'LEGACY-SHARED-MEMORY', home); // no userId

    // Mint the two channel sessions by driving a (default-reply) turn each, so
    // each session row exists with its owner stamped.
    const channels: ChannelsConfig = {
      webhook: { enabled: true, secret: WEBHOOK_SECRET, principalId: WEBHOOK_PRINCIPAL },
    };
    const app = buildAppWithRuntime(runtime, { channels });

    const whRaw = JSON.stringify({ sender: 'wh-user', text: 'hi', chatId: 'wh-chat' });
    const whRes = await app.request(`/channels/webhook/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': signWebhook(whRaw, WEBHOOK_SECRET) },
      body: whRaw,
    });
    expect(whRes.status).toBe(200);

    // Re-derive the live webhook session context and probe its memory observable
    // (the same prefetchSnapshot query() injects). It must see ONLY wh's memory.
    const whSessionId = buildSessionKey({
      channel: 'webhook',
      sender: 'wh-user',
      chatId: 'wh-chat',
      chatType: 'private',
      text: 'hi',
    });
    runtime.sessionDb.upsertSession({
      sessionId: whSessionId,
      owner: WEBHOOK_PRINCIPAL,
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
    });
    const whCtx = runtime.getSessionContext(whSessionId);
    expect(whCtx.userId).toBe(WEBHOOK_PRINCIPAL);
    const whSnap = await whCtx.memoryManager.prefetchSnapshot('hi');
    expect(whSnap).toContain('WH-SECRET-MEMORY');
    expect(whSnap).not.toContain('SK-SECRET-MEMORY');
    expect(whSnap).not.toContain('HUMAN-SECRET-MEMORY');
    expect(whSnap).not.toContain('LEGACY-SHARED-MEMORY');
    await runtime.disposeSession(whSessionId);

    // A separately-derived slack-principal session sees ONLY sk's memory.
    const skSessionId = buildSessionKey({
      channel: 'slack',
      sender: 'sk-user',
      chatId: 'C-sk',
      chatType: 'channel',
      text: 'hi',
    });
    runtime.sessionDb.upsertSession({
      sessionId: skSessionId,
      owner: SLACK_PRINCIPAL,
      model: runtime.model,
      provider: runtime.resolvedProvider.transport.name,
    });
    const skCtx = runtime.getSessionContext(skSessionId);
    expect(skCtx.userId).toBe(SLACK_PRINCIPAL);
    const skSnap = await skCtx.memoryManager.prefetchSnapshot('hi');
    expect(skSnap).toContain('SK-SECRET-MEMORY');
    expect(skSnap).not.toContain('WH-SECRET-MEMORY');
    expect(skSnap).not.toContain('HUMAN-SECRET-MEMORY');
    expect(skSnap).not.toContain('LEGACY-SHARED-MEMORY');
    await runtime.disposeSession(skSessionId);
  });

  // ===========================================================================
  // 2. Conservative permission posture (the crux)
  // ===========================================================================
  //
  // A channel turn does NOT inherit the local dev's settings.local.json
  // allow-rules. We seed an on-disk `allow: ['Bash(*)','Write(*)']` rule at the
  // cwd's .harness/settings.local.json — the exact file loadPermissionSettings
  // reads — then drive a channel turn that scripts Bash. The Bash command would
  // create a sentinel; under the channel decider it must be DENIED and the
  // sentinel never written. A control proves the seeded file IS effective for a
  // path that DOES consult it, so the test isn't vacuously green.

  /** Seed `<cwd>/.harness/settings.local.json` with allow rules. cwd === home. */
  function seedLocalAllow(rules: string[]): void {
    const dir = join(home, '.harness');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: rules, deny: [], ask: [] } }),
      'utf8',
    );
  }

  test('control — loadPermissionSettings DOES pick up the seeded local allow rule', () => {
    // This is the negative-control: prove the seeded file is real + effective so
    // the posture test below is meaningfully testing non-inheritance, not a
    // file that was silently ignored.
    seedLocalAllow(['Bash(*)', 'Write(*)']);
    const loaded = loadPermissionSettings({ cwd: home, harnessHome: home });
    const allRules = loaded.layers.flatMap((l) => l.rules);
    // A parsed rule is { tool, content, behavior, raw } — `Bash(*)` → tool 'Bash',
    // content '*'. Assert the seeded allow rules are present + correctly parsed.
    const allowRaws = allRules.filter((r) => r.behavior === 'allow').map((r) => r.raw);
    const allowTools = allRules.filter((r) => r.behavior === 'allow').map((r) => r.tool);
    expect(allowRaws).toContain('Bash(*)');
    expect(allowRaws).toContain('Write(*)');
    expect(allowTools).toContain('Bash');
    expect(allowTools).toContain('Write');
    expect(loaded.sources.some((s) => s.endsWith('settings.local.json'))).toBe(true);
  });

  test('crux — channel Bash turn is DENIED even with an on-disk allow Bash(*) rule', async () => {
    // The load-bearing security property: a remote attacker cannot ride a
    // developer's `allow: Bash(*)` to run shell commands through a channel.
    seedLocalAllow(['Bash(*)', 'Write(*)']);

    const sentinel = join(home, 'PWNED-via-allow-rule.txt');
    bashThenDoneScript(sentinel);

    const channels: ChannelsConfig = {
      webhook: { enabled: true, secret: WEBHOOK_SECRET, principalId: WEBHOOK_PRINCIPAL },
    };
    const app = buildAppWithRuntime(runtime, { channels });
    const raw = JSON.stringify({ sender: 'wh-user', text: 'run bash', chatId: 'wh-chat' });

    const res = await app.request(`/channels/webhook/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': signWebhook(raw, WEBHOOK_SECRET) },
      body: raw,
    });
    expect(res.status).toBe(200);

    // DESPITE the on-disk allow rule, Bash was denied → the sentinel never
    // existed. (The control test above proves that rule IS otherwise effective.)
    expect(existsSync(sentinel)).toBe(false);
    // The turn still completed and surfaced the model's text reply.
    const json = (await res.json()) as { reply?: string };
    expect(json.reply).toBe('done.');
  });

  test('crux — channel Write turn is DENIED even with an on-disk allow Write(*) rule', async () => {
    // Same property for Write (the other mutating tool that self-checks 'ask').
    seedLocalAllow(['Bash(*)', 'Write(*)']);

    const target = join(home, 'WRITTEN-via-allow-rule.txt');
    MockProvider.toolUseScript = [
      {
        kind: 'tool_use',
        name: 'Write',
        input: { file_path: target, content: 'pwned' },
        id: 'ci-write-0',
      },
      { kind: 'text', text: 'done.' },
    ];
    MockProvider.resetScriptCursor();

    const channels: ChannelsConfig = {
      webhook: { enabled: true, secret: WEBHOOK_SECRET, principalId: WEBHOOK_PRINCIPAL },
    };
    const app = buildAppWithRuntime(runtime, { channels });
    const raw = JSON.stringify({ sender: 'wh-user', text: 'write file', chatId: 'wh-chat' });

    const res = await app.request(`/channels/webhook/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': signWebhook(raw, WEBHOOK_SECRET) },
      body: raw,
    });
    expect(res.status).toBe(200);

    // Write was denied → the target file was never created.
    expect(existsSync(target)).toBe(false);
  });

  // ===========================================================================
  // 3. Inbound auth is enforced (no turn on bad auth)
  // ===========================================================================
  //
  // Verification runs BEFORE any parse/turn, so a forged/replayed request
  // creates no session and runs no model call. We assert BOTH the status code
  // AND the absence of the side-effect (no session row, no learning namespace).

  test('webhook — bad HMAC → 401, no session, no turn, no learning write', async () => {
    bashThenDoneScript(join(home, 'should-not-exist.txt'));
    MockProvider.streamCalls = 0;

    const channels: ChannelsConfig = {
      webhook: { enabled: true, secret: WEBHOOK_SECRET, principalId: WEBHOOK_PRINCIPAL },
    };
    const app = buildAppWithRuntime(runtime, { channels });
    const raw = JSON.stringify({ sender: 'wh-user', text: 'run', chatId: 'wh-chat' });

    const res = await app.request(`/channels/webhook/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': signWebhook(raw, 'WRONG-SECRET') },
      body: raw,
    });

    expect(res.status).toBe(401);
    // No side-effect: no provider call, no session row, no per-user corpus.
    expect(MockProvider.streamCalls).toBe(0);
    const sessionId = buildSessionKey({
      channel: 'webhook',
      sender: 'wh-user',
      chatId: 'wh-chat',
      chatType: 'private',
      text: 'run',
    });
    expect(runtime.sessionDb.getSession(sessionId)).toBeNull();
    expect(existsSync(join(home, 'users', WEBHOOK_PRINCIPAL))).toBe(false);
  });

  test('webhook — missing HMAC header → 401, no session, no turn', async () => {
    MockProvider.streamCalls = 0;
    const channels: ChannelsConfig = {
      webhook: { enabled: true, secret: WEBHOOK_SECRET, principalId: WEBHOOK_PRINCIPAL },
    };
    const app = buildAppWithRuntime(runtime, { channels });
    const raw = JSON.stringify({ sender: 'wh-user', text: 'run', chatId: 'wh-chat' });

    const res = await app.request(`/channels/webhook/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER }, // no X-Signature
      body: raw,
    });

    expect(res.status).toBe(401);
    expect(MockProvider.streamCalls).toBe(0);
    const sessionId = buildSessionKey({
      channel: 'webhook',
      sender: 'wh-user',
      chatId: 'wh-chat',
      chatType: 'private',
      text: 'run',
    });
    expect(runtime.sessionDb.getSession(sessionId)).toBeNull();
  });

  test('slack — bad signature → 403, no session, no turn, no post', async () => {
    const { transport, posted } = makeMockSlackTransport();
    const bg = makeBackgroundCollector();
    MockProvider.streamCalls = 0;

    const channels: ChannelsConfig = {
      slack: {
        enabled: true,
        signingSecret: SLACK_SIGNING_SECRET,
        botToken: SLACK_BOT_TOKEN,
        principalId: SLACK_PRINCIPAL,
      },
    };
    const app = buildAppWithRuntime(
      runtime,
      { channels },
      {
        slackTransport: transport,
        onBackgroundTask: bg.onBackgroundTask,
      },
    );

    const ts = nowSecs();
    const raw = slackEventBody({ user: 'sk-user', channel: 'C-sk', text: 'run' });
    const res = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        ...JSON_HEADER,
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': signSlack(raw, ts, 'WRONG-SIGNING-SECRET'),
      },
      body: raw,
    });

    expect(res.status).toBe(403);
    await bg.drain();
    expect(posted).toEqual([]);
    expect(MockProvider.streamCalls).toBe(0);
    const sessionId = buildSessionKey({
      channel: 'slack',
      sender: 'sk-user',
      chatId: 'C-sk',
      chatType: 'channel',
      text: 'run',
    });
    expect(runtime.sessionDb.getSession(sessionId)).toBeNull();
    expect(existsSync(join(home, 'users', SLACK_PRINCIPAL))).toBe(false);
  });

  test('slack — stale timestamp (> 300s) → 403, no session, no turn', async () => {
    const { transport, posted } = makeMockSlackTransport();
    const bg = makeBackgroundCollector();
    MockProvider.streamCalls = 0;

    const channels: ChannelsConfig = {
      slack: {
        enabled: true,
        signingSecret: SLACK_SIGNING_SECRET,
        botToken: SLACK_BOT_TOKEN,
        principalId: SLACK_PRINCIPAL,
      },
    };
    const app = buildAppWithRuntime(
      runtime,
      { channels },
      {
        slackTransport: transport,
        onBackgroundTask: bg.onBackgroundTask,
      },
    );

    // 301s in the past — outside the replay window — but a correctly-computed
    // signature OVER that stale timestamp (so only the replay check rejects it).
    const staleTs = String(Math.floor(Date.now() / 1000) - 301);
    const raw = slackEventBody({ user: 'sk-user', channel: 'C-sk', text: 'run' });
    const res = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        ...JSON_HEADER,
        'X-Slack-Request-Timestamp': staleTs,
        'X-Slack-Signature': signSlack(raw, staleTs, SLACK_SIGNING_SECRET),
      },
      body: raw,
    });

    expect(res.status).toBe(403);
    await bg.drain();
    expect(posted).toEqual([]);
    expect(MockProvider.streamCalls).toBe(0);
    const sessionId = buildSessionKey({
      channel: 'slack',
      sender: 'sk-user',
      chatId: 'C-sk',
      chatType: 'channel',
      text: 'run',
    });
    expect(runtime.sessionDb.getSession(sessionId)).toBeNull();
  });

  // ===========================================================================
  // 4. `bypass` is rejected
  // ===========================================================================

  test('bypass — config with permissionMode:bypass fails to parse (schema enum)', () => {
    // The schema enum is ['default','ask'] by construction, so 'bypass' is a
    // PARSE error, not a refinement. Proven for each channel kind.
    const base = {
      gateway: {
        principals: [{ id: WEBHOOK_PRINCIPAL, token: WEBHOOK_PRINCIPAL_TOKEN }],
      },
    };
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          ...base.gateway,
          channels: {
            webhook: {
              enabled: true,
              secret: WEBHOOK_SECRET,
              principalId: WEBHOOK_PRINCIPAL,
              permissionMode: 'bypass',
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          ...base.gateway,
          channels: {
            slack: {
              enabled: true,
              signingSecret: SLACK_SIGNING_SECRET,
              botToken: SLACK_BOT_TOKEN,
              principalId: WEBHOOK_PRINCIPAL,
              permissionMode: 'bypass',
            },
          },
        },
      }),
    ).toThrow();
    // Control: the SAME shape with an ALLOWED mode parses cleanly — proving the
    // rejection is about 'bypass', not the surrounding shape.
    expect(() =>
      SettingsSchema.parse({
        gateway: {
          ...base.gateway,
          channels: {
            webhook: {
              enabled: true,
              secret: WEBHOOK_SECRET,
              principalId: WEBHOOK_PRINCIPAL,
              permissionMode: 'ask',
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test('bypass — assertChannelPermissionMode throws on bypass, accepts default/ask', () => {
    expect(() => assertChannelPermissionMode('bypass')).toThrow(/bypass/);
    // Any other unknown value is rejected too (defense-in-depth at the boundary).
    expect(() => assertChannelPermissionMode('yolo')).toThrow();
    // The two permitted modes pass.
    expect(() => assertChannelPermissionMode('default')).not.toThrow();
    expect(() => assertChannelPermissionMode('ask')).not.toThrow();
  });

  // ===========================================================================
  // 5. No cross-principal escalation via the API
  // ===========================================================================
  //
  // A channel principal is a NORMAL Phase-E principal. If it also holds a
  // gateway bearer token, it must NOT be able to read another principal's
  // sessions through /sessions/*. And a channel-created session (owned by the
  // channel principal) must be owner-scoped: a DIFFERENT principal cannot read
  // it nor see it in their listing.
  //
  // FINDING (a real hint for 8b): a channel session id is the colon-delimited
  // conversation key `agent:main:<channel>:<chatType>:<chatId>` (buildSessionKey).
  // The gateway's `isValidSessionId` only accepts `^[A-Za-z0-9_-]+$` — NO colons
  // — so EVERY per-session route (`GET/DELETE /sessions/:id`, `/messages`,
  // `/turns`, `/events`) rejects a channel id with 400 "invalid session id"
  // BEFORE the ownership check runs. Net security effect: a channel session is
  // simply NOT addressable through the per-session REST surface — by anyone,
  // owner included — which is fail-closed (no content can leak). The OWNER-
  // SCOPING that IS observable is the listing (`GET /sessions`), which filters by
  // owner regardless of id shape. So we assert: (a) a non-owner gets NO content
  // on the per-session routes (status ∈ {400,404}, never 200, body never carries
  // the message text); (b) the listing shows the session to its owner and HIDES
  // it from a different principal. The id-validation-before-ownership asymmetry
  // means `loadOwnedSession`'s 404 branch is effectively never exercised for
  // channel ids — worth an explicit look in 8b.

  test('a channel-created session is owner-scoped; a different principal gets no access + cannot list it', async () => {
    // Register two principals: the channel's (wh) AND a human user, each with a
    // gateway token. The channel binds to wh. The human drives the same gateway
    // /sessions/* API and must NOT be able to reach the wh-owned channel session.
    const principals = [
      { id: WEBHOOK_PRINCIPAL, token: WEBHOOK_PRINCIPAL_TOKEN },
      { id: HUMAN_PRINCIPAL, token: HUMAN_TOKEN },
    ];
    const channels: ChannelsConfig = {
      webhook: { enabled: true, secret: WEBHOOK_SECRET, principalId: WEBHOOK_PRINCIPAL },
    };
    // principals + channels coexist: channel route is OPEN (HMAC-authed), the
    // /sessions/* routes are principal-gated.
    const app = buildAppWithRuntime(runtime, { principals, channels });

    // The webhook channel creates a session owned by wh (no gateway token used —
    // the channel authenticates via its HMAC). Use a distinctive message text so
    // we can prove it never leaks into a non-owner's response body.
    const secretText = 'CHANNEL-PRIVATE-CONTENT-xyz';
    const raw = JSON.stringify({ sender: 'wh-user', text: secretText, chatId: 'wh-chat' });
    const whRes = await app.request(`/channels/webhook/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': signWebhook(raw, WEBHOOK_SECRET) },
      body: raw,
    });
    expect(whRes.status).toBe(200);
    const channelSessionId = buildSessionKey({
      channel: 'webhook',
      sender: 'wh-user',
      chatId: 'wh-chat',
      chatType: 'private',
      text: secretText,
    });
    // Sanity: the row exists, owned by the channel principal, and the private
    // message text is genuinely stored (so the no-leak assertions are meaningful).
    expect(runtime.sessionDb.getSession(channelSessionId)?.ownerId).toBe(WEBHOOK_PRINCIPAL);
    expect(JSON.stringify(runtime.sessionDb.loadMessages(channelSessionId))).toContain(secretText);

    const HUMAN: Record<string, string> = { authorization: `Bearer ${HUMAN_TOKEN}` };

    // The HUMAN principal gets NO access through ANY per-session route. The
    // status is 400 (id-validation rejects the colon id) or 404 (ownership) —
    // either way NOT 200, and the private content never appears in the body.
    const noAccess = async (res: Response): Promise<void> => {
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain(secretText);
    };
    await noAccess(await app.request(`/sessions/${channelSessionId}`, { headers: HUMAN }));
    await noAccess(await app.request(`/sessions/${channelSessionId}/messages`, { headers: HUMAN }));
    await noAccess(
      await app.request(`/sessions/${channelSessionId}/turns`, {
        method: 'POST',
        headers: { ...HUMAN, ...JSON_HEADER },
        body: JSON.stringify({ text: 'intrude' }),
      }),
    );
    await noAccess(await app.request(`/sessions/${channelSessionId}/events`, { headers: HUMAN }));
    await noAccess(
      await app.request(`/sessions/${channelSessionId}`, { method: 'DELETE', headers: HUMAN }),
    );

    // The human's rejected intrusions left the channel session intact (no
    // message appended by the rejected /turns, row not deleted).
    expect(runtime.sessionDb.getSession(channelSessionId)).not.toBeNull();

    // GET /sessions is owner-scoped (filters by owner regardless of id shape):
    // the human does NOT see the channel session; its owner DOES.
    const humanList = await app.request('/sessions', { headers: HUMAN });
    const humanBody = (await humanList.json()) as { sessions: Array<{ sessionId: string }> };
    expect(humanBody.sessions.some((s) => s.sessionId === channelSessionId)).toBe(false);

    const WH: Record<string, string> = { authorization: `Bearer ${WEBHOOK_PRINCIPAL_TOKEN}` };
    const whList = await app.request('/sessions', { headers: WH });
    const whBody = (await whList.json()) as { sessions: Array<{ sessionId: string }> };
    expect(whBody.sessions.some((s) => s.sessionId === channelSessionId)).toBe(true);
  });

  test('an unauthenticated caller cannot list or reach a channel session through the gated API', async () => {
    // Even with principals registered, the gated /sessions/* routes require a
    // valid principal token; an anonymous request (no bearer) is rejected by
    // principalAuth (401) before any session logic — and the anonymous listing
    // is likewise rejected, so no channel session is enumerable without auth.
    const principals = [{ id: WEBHOOK_PRINCIPAL, token: WEBHOOK_PRINCIPAL_TOKEN }];
    const channels: ChannelsConfig = {
      webhook: { enabled: true, secret: WEBHOOK_SECRET, principalId: WEBHOOK_PRINCIPAL },
    };
    const app = buildAppWithRuntime(runtime, { principals, channels });

    const raw = JSON.stringify({ sender: 'wh-user', text: 'hi', chatId: 'wh-chat' });
    await app.request(`/channels/webhook/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': signWebhook(raw, WEBHOOK_SECRET) },
      body: raw,
    });
    const channelSessionId = buildSessionKey({
      channel: 'webhook',
      sender: 'wh-user',
      chatId: 'wh-chat',
      chatType: 'private',
      text: 'hi',
    });

    // No Authorization header → principalAuth rejects (401) on both the
    // per-session route and the listing, never reaching session logic.
    const anonGet = await app.request(`/sessions/${channelSessionId}`);
    expect(anonGet.status).toBe(401);
    const anonList = await app.request('/sessions');
    expect(anonList.status).toBe(401);
  });

  // ===========================================================================
  // 6. Secrets aren't echoed
  // ===========================================================================
  //
  // A bad-auth rejection response body must never contain the configured secret
  // / signing secret / bot token — leaking it would defeat the whole auth model.

  test('webhook 401 body does not echo the webhook secret', async () => {
    const channels: ChannelsConfig = {
      webhook: { enabled: true, secret: WEBHOOK_SECRET, principalId: WEBHOOK_PRINCIPAL },
    };
    const app = buildAppWithRuntime(runtime, { channels });
    const raw = JSON.stringify({ sender: 'wh-user', text: 'run', chatId: 'wh-chat' });

    const res = await app.request(`/channels/webhook/${WEBHOOK_ID}`, {
      method: 'POST',
      headers: { ...JSON_HEADER, 'X-Signature': signWebhook(raw, 'WRONG-SECRET') },
      body: raw,
    });

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(WEBHOOK_SECRET);
  });

  test('slack 403 body does not echo the signing secret or bot token', async () => {
    const { transport } = makeMockSlackTransport();
    const channels: ChannelsConfig = {
      slack: {
        enabled: true,
        signingSecret: SLACK_SIGNING_SECRET,
        botToken: SLACK_BOT_TOKEN,
        principalId: SLACK_PRINCIPAL,
      },
    };
    const app = buildAppWithRuntime(runtime, { channels }, { slackTransport: transport });

    const ts = nowSecs();
    const raw = slackEventBody({ user: 'sk-user', channel: 'C-sk', text: 'run' });
    const res = await app.request('/channels/slack/events', {
      method: 'POST',
      headers: {
        ...JSON_HEADER,
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': signSlack(raw, ts, 'WRONG-SIGNING-SECRET'),
      },
      body: raw,
    });

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain(SLACK_SIGNING_SECRET);
    expect(body).not.toContain(SLACK_BOT_TOKEN);
  });
});
