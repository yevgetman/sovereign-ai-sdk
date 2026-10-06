import { spawn } from 'node:child_process';
import { CHATGPT_OAUTH_CLIENT_ID } from '../chatgpt.js';
import { GROK_OAUTH_CLIENT_ID } from '../grok.js';
import { CLAUDE_MAX_TERMS_MESSAGE } from './claudeMaxTerms.js';
import { KEYCHAIN_SERVICE, isSubscriptionName } from './names.js';
import { formBody, recordFromTokenJson } from './oauth.js';
import type { SubscriptionCredentialPort, SubscriptionFetch } from './port.js';

const CODEX_ISSUER = 'https://auth.openai.com';
const XAI_DISCOVERY = 'https://auth.x.ai/.well-known/openid-configuration';
const XAI_DEVICE = 'https://auth.x.ai/oauth2/device/code';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export type LoginIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  openUrl: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  fetchImpl: SubscriptionFetch;
};

/** Open the system browser. A failure does not fail login; the URL is printed. */
export function openSystemBrowser(url: string): void {
  try {
    const child = spawn('open', [url], { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // The URL is already on stdout.
  }
}

export function defaultLoginIo(): LoginIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    openUrl: openSystemBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    fetchImpl: fetch,
  };
}

/** Attended login. Prints no token. Returns a process exit code. */
export async function loginSubscription(
  name: string,
  port: SubscriptionCredentialPort,
  io: LoginIo,
): Promise<number> {
  if (!isSubscriptionName(name)) {
    io.stderr(`unknown subscription provider ${name}\n`);
    return 1;
  }
  if (name === 'claude-max') {
    io.stderr(`${CLAUDE_MAX_TERMS_MESSAGE}\n`);
    return 1;
  }
  try {
    if (name === 'chatgpt') return await loginChatGpt(port, io);
    return await loginGrok(port, io);
  } catch {
    io.stderr(`${name} login failed\n`);
    return 1;
  }
}

/** Delete the Keychain item. `claude-max` may be deleted; it is never used. */
export async function logoutSubscription(
  name: string,
  port: SubscriptionCredentialPort,
  io: LoginIo,
): Promise<number> {
  if (!isSubscriptionName(name)) {
    io.stderr(`unknown subscription provider ${name}\n`);
    return 1;
  }
  try {
    await port.delete(KEYCHAIN_SERVICE[name]);
  } catch {
    io.stderr(`${name} logout failed\n`);
    return 1;
  }
  io.stdout(`signed out of ${name}\n`);
  return 0;
}

async function loginChatGpt(port: SubscriptionCredentialPort, io: LoginIo): Promise<number> {
  const deviceRes = await io.fetchImpl(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID }),
  });
  if (!deviceRes.ok) {
    io.stderr('chatgpt login failed\n');
    return 1;
  }
  const device = (await deviceRes.json()) as Record<string, unknown>;
  const userCode = typeof device.user_code === 'string' ? device.user_code : '';
  const deviceAuthId = typeof device.device_auth_id === 'string' ? device.device_auth_id : '';
  if (!userCode || !deviceAuthId) {
    io.stderr('chatgpt login failed\n');
    return 1;
  }
  const url = `${CODEX_ISSUER}/codex/device`;
  io.stdout(`Open ${url}\nEnter code ${userCode}\n`);
  safeOpen(io, url);
  const intervalMs = Math.max(1, Number(device.interval) || 5) * 1000;
  const deadline = io.now() + 15 * 60 * 1000;
  let polls = 0;
  let codeResp: Record<string, unknown> | null = null;
  while (io.now() < deadline && polls < 180) {
    polls += 1;
    await io.sleep(intervalMs);
    const poll = await io.fetchImpl(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    if (poll.status === 403 || poll.status === 404) continue;
    if (!poll.ok) {
      io.stderr('chatgpt login failed\n');
      return 1;
    }
    codeResp = (await poll.json()) as Record<string, unknown>;
    break;
  }
  if (!codeResp) {
    io.stderr('chatgpt login timed out\n');
    return 1;
  }
  const authorizationCode =
    typeof codeResp.authorization_code === 'string' ? codeResp.authorization_code : '';
  const codeVerifier = typeof codeResp.code_verifier === 'string' ? codeResp.code_verifier : '';
  if (!authorizationCode || !codeVerifier) {
    io.stderr('chatgpt login failed\n');
    return 1;
  }
  const tokenRes = await io.fetchImpl(`${CODEX_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: formBody({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    io.stderr('chatgpt login failed\n');
    return 1;
  }
  const record = recordFromTokenJson('chatgpt', await tokenRes.json(), io.now(), '');
  await port.write(KEYCHAIN_SERVICE.chatgpt, record);
  io.stdout('signed in to chatgpt\n');
  return 0;
}

async function loginGrok(port: SubscriptionCredentialPort, io: LoginIo): Promise<number> {
  const discoveryRes = await io.fetchImpl(XAI_DISCOVERY, {
    headers: { accept: 'application/json' },
  });
  if (!discoveryRes.ok) {
    io.stderr('grok login failed\n');
    return 1;
  }
  const discovery = (await discoveryRes.json()) as { token_endpoint?: unknown };
  const tokenEndpoint =
    typeof discovery.token_endpoint === 'string' ? discovery.token_endpoint : '';
  if (!tokenEndpoint.startsWith('https://auth.x.ai/')) {
    io.stderr('grok login failed\n');
    return 1;
  }
  const deviceRes = await io.fetchImpl(XAI_DEVICE, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: formBody({ client_id: GROK_OAUTH_CLIENT_ID, scope: XAI_SCOPE }),
  });
  if (!deviceRes.ok) {
    io.stderr('grok login failed\n');
    return 1;
  }
  const device = (await deviceRes.json()) as Record<string, unknown>;
  const deviceCode = typeof device.device_code === 'string' ? device.device_code : '';
  const userCode = typeof device.user_code === 'string' ? device.user_code : '';
  const verify =
    typeof device.verification_uri_complete === 'string'
      ? device.verification_uri_complete
      : typeof device.verification_uri === 'string'
        ? device.verification_uri
        : '';
  if (!deviceCode || !userCode || !verify) {
    io.stderr('grok login failed\n');
    return 1;
  }
  io.stdout(`Open ${verify}\nEnter code ${userCode}\n`);
  safeOpen(io, verify);
  let intervalMs = Math.max(1, Number(device.interval) || 5) * 1000;
  const expiresIn = Math.max(1, Number(device.expires_in) || 900);
  const deadline = io.now() + expiresIn * 1000;
  let polls = 0;
  while (io.now() < deadline && polls < 180) {
    polls += 1;
    await io.sleep(intervalMs);
    const poll = await io.fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: formBody({
        grant_type: DEVICE_GRANT,
        client_id: GROK_OAUTH_CLIENT_ID,
        device_code: deviceCode,
      }),
    });
    if (poll.ok) {
      const record = recordFromTokenJson('grok', await poll.json(), io.now(), '');
      await port.write(KEYCHAIN_SERVICE.grok, record);
      io.stdout('signed in to grok\n');
      return 0;
    }
    const error = await oauthError(poll);
    if (error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    if (error === 'authorization_pending') continue;
    io.stderr('grok login failed\n');
    return 1;
  }
  io.stderr('grok login timed out\n');
  return 1;
}

function safeOpen(io: LoginIo, url: string): void {
  try {
    io.openUrl(url);
  } catch {
    // The URL is already on stdout.
  }
}

async function oauthError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}
