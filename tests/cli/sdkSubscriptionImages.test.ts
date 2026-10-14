import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Message, StreamEvent } from '@yevgetman/sov-sdk/core/types';
import { ContextOverflowError } from '@yevgetman/sov-sdk/providers/errors';
import { grokSubscriptionPin } from '@yevgetman/sov-sdk/providers/models/grokPin';
import { getRoute } from '@yevgetman/sov-sdk/providers/routes/index';
import { macKeychainPort } from '@yevgetman/sov-sdk/providers/subscription/keychain';
import type { LLMProvider, ProviderRequest, Transport } from '@yevgetman/sov-sdk/providers/types';
import { buildTool } from '@yevgetman/sov-sdk/tool/buildTool';
import { z } from 'zod';
import { SessionDb } from '../../src/agent/sessionDb.js';
import { importOwnerGrokRegistry } from '../../src/cli/ownerModelRegistry.js';
import { type SdkRunDependencies, runSdkRunCommand } from '../../src/cli/sdkRunCommand.js';
import { buildRuntime } from '../../src/server/runtime.js';

const dirs: string[] = [];
const initialHome = process.env.HARNESS_HOME;
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>>;
beforeEach(() => {
  clock = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-14T18:00:00.000Z'));
});
afterEach(() => {
  clock.mockRestore();
  if (initialHome === undefined) Reflect.deleteProperty(process.env, 'HARNESS_HOME');
  else process.env.HARNESS_HOME = initialHome;
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const options = {
  json: true,
  stdin: true,
  route: 'grok-subscription',
  model: 'grok-4.7',
  effort: 'low',
  inputFormat: 'json',
  toolset: 'chat',
  maxTokens: 64,
};
function fixture(provider: LLMProvider) {
  const directory = mkdtempSync(join(tmpdir(), 'native-subscription-images-'));
  dirs.push(directory);
  process.env.HARNESS_HOME = directory;
  const dbPath = join(directory, 'sessions.db');
  const imagePath = join(directory, 'image.png');
  writeFileSync(imagePath, png);
  const events: Record<string, unknown>[] = [];
  let resolutions = 0;
  const deps: SdkRunDependencies = {
    resolve: async (_routeId, selection) => {
      resolutions++;
      const model = selection?.model ?? 'grok-4.7';
      return {
        route: getRoute('grok-subscription', {}),
        provider,
        model,
        effort: 'low',
        resolved: {
          transport: provider as Transport,
          client: provider,
          baseUrl: 'mock://',
          model,
          contextLength: 500000,
          authType: 'oauth',
          metadata: { provider: 'grok', apiMode: 'openai', purpose: 'main' },
        },
      };
    },
    runtime: async (opts) => {
      const runtime = await buildRuntime({
        ...opts,
        cwd: directory,
        harnessHome: directory,
        dbPath,
        settings: {
          learning: {
            disabled: true,
            recall: { enabled: false, maxLessons: 8, tokenBudget: 1200 },
          },
          review: { disabled: true },
        },
        cronEnabled: false,
      });
      runtime.systemSegments.splice(0, runtime.systemSegments.length, {
        text: 'Inspect user images.',
        cacheable: false,
      });
      runtime.proactiveCompactThreshold = 1;
      return runtime;
    },
  };
  const io = {
    readStdin: async () =>
      JSON.stringify({
        inputVersion: 1,
        text: '',
        images: [{ path: imagePath, mediaType: 'image/png' }],
      }),
    writeStdout: (line: string) => events.push(JSON.parse(line)),
  };
  return { directory, imagePath, dbPath, events, io, deps, resolutions: () => resolutions };
}
function final(text = 'image inspected'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
function images(messages: readonly Message[]) {
  return messages.flatMap((message) => message.content.filter((block) => block.type === 'image'));
}

for (const withCertificate of [false, true]) {
  test(`native established owner profile admits image with ${withCertificate ? 'fresh certificate and aged metadata' : 'independent legacy transport proof'}`, async () => {
    const requests: ProviderRequest[] = [];
    const provider: LLMProvider = {
      name: 'grok',
      async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
        requests.push(request);
        const answer = final();
        yield { type: 'assistant_message', message: answer };
        return answer;
      },
    };
    const f = fixture(provider);
    const saved = { HOME: process.env.HOME, HARNESS_CONFIG: process.env.HARNESS_CONFIG };
    process.env.HOME = f.directory;
    process.env.HARNESS_CONFIG = join(f.directory, 'config.json');
    try {
      const pin = grokSubscriptionPin('grok-4.7');
      const { imageInputCertification, reasoningControl, ...legacy } = pin;
      const reviewedAt = new Date(Date.now() - 7200000).toISOString();
      const fake = macKeychainPort({
        exec: async () => ({
          code: 0,
          stdout: JSON.stringify({
            accessToken: 'FIXTURE-ONLY',
            refreshToken: 'FIXTURE-ONLY',
            expiresAt: Date.now() + 100000,
          }),
        }),
      });
      await importOwnerGrokRegistry(
        {
          version: 1,
          routeId: 'grok-subscription',
          fetchedAt: reviewedAt,
          models: [
            {
              ...legacy,
              ...(withCertificate ? { imageInputCertification } : {}),
              metadata: { source: 'owner-reviewed-fixture', fetchedAt: reviewedAt, stale: false },
            },
          ],
        },
        { harnessHome: f.directory, port: fake },
      );
      expect(await runSdkRunCommand(options, f.io, f.deps)).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.modelMetadata?.metadata).toMatchObject({
        ownerManaged: true,
        stale: true,
        source: 'owner-reviewed-fixture',
      });
      expect(requests[0]?.modelMetadata?.imageInputCertification).toEqual(imageInputCertification);
      expect(images(requests[0]?.messages ?? [])).toHaveLength(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
}

test('native certified image-only/multiple input persists and resumes through exact model; unverified switch refuses', async () => {
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'grok',
    async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
      requests.push(request);
      const answer = final();
      yield { type: 'assistant_message', message: answer };
      return answer;
    },
  };
  const f = fixture(provider);
  f.io.readStdin = async () =>
    JSON.stringify({
      inputVersion: 1,
      text: '',
      images: [
        { path: f.imagePath, mediaType: 'image/png' },
        { path: f.imagePath, mediaType: 'image/png' },
      ],
    });
  expect(await runSdkRunCommand(options, f.io, f.deps)).toBe(0);
  const id = String(f.events.at(-1)?.activeSessionId);
  expect(images(requests[0]?.messages ?? [])).toHaveLength(2);
  f.io.readStdin = async () =>
    JSON.stringify({ inputVersion: 1, text: 'Refer to the saved images.' });
  expect(await runSdkRunCommand({ ...options, resume: id }, f.io, f.deps)).toBe(0);
  expect(images(requests[1]?.messages ?? [])).toHaveLength(2);
  expect(await runSdkRunCommand({ ...options, model: 'grok-4.6', resume: id }, f.io, f.deps)).toBe(
    2,
  );
  expect(f.events.at(-1)?.code).toBe('unsupported_input');
  expect(requests).toHaveLength(2);
  const db = SessionDb.open({ path: f.dbPath });
  try {
    expect(images(db.loadMessages(id))).toHaveLength(2);
  } finally {
    db.close();
  }
  expect(JSON.stringify(f.events)).not.toContain(png.toString('base64'));
});

test('native unverified model and unsupported MIME refuse before credentials or runtime', async () => {
  let inference = 0;
  const provider: LLMProvider = {
    name: 'grok',
    async *stream(): AsyncGenerator<StreamEvent, AssistantMessage> {
      inference++;
      const answer = final();
      yield { type: 'assistant_message', message: answer };
      return answer;
    },
  };
  const f = fixture(provider);
  expect(await runSdkRunCommand({ ...options, model: 'grok-4.6' }, f.io, f.deps)).toBe(2);
  expect(f.events.at(-1)?.code).toBe('unsupported_input');
  expect(f.resolutions()).toBe(0);
  f.io.readStdin = async () =>
    JSON.stringify({
      inputVersion: 1,
      text: 'inspect',
      images: [{ path: '/missing/image.gif', mediaType: 'image/gif' }],
    });
  expect(await runSdkRunCommand(options, f.io, f.deps)).toBe(2);
  expect(f.events.at(-1)?.code).toBe('unsupported_input');
  expect(f.resolutions()).toBe(0);
  expect(inference).toBe(0);
});

test('native tool continuation retains image with durable tool receipts', async () => {
  let calls = 0;
  let ran = 0;
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'grok',
    async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
      calls++;
      requests.push(request);
      const answer: AssistantMessage =
        calls === 1
          ? {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'image-call', name: 'image_receipt', input: {} }],
            }
          : final();
      yield { type: 'assistant_message', message: answer };
      return answer;
    },
  };
  const f = fixture(provider);
  const boot = f.deps.runtime;
  f.deps.runtime = async (opts) => {
    if (!boot) throw Error('missing boot');
    const runtime = await boot(opts);
    runtime.toolPool.splice(
      0,
      runtime.toolPool.length,
      buildTool<unknown, unknown>({
        name: 'image_receipt',
        description: () => 'Return a receipt.',
        inputSchema: z.object({}),
        renderResult: () => ({ content: 'receipt' }),
        checkPermissions: async () => ({ behavior: 'allow' }),
        call: async () => {
          ran++;
          return { data: 'receipt' };
        },
      }),
    );
    return runtime;
  };
  expect(
    await runSdkRunCommand(
      { ...options, toolset: 'coding', permissionMode: 'bypass' },
      f.io,
      f.deps,
    ),
  ).toBe(0);
  expect(ran).toBe(1);
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(images(request.messages)).toHaveLength(1);
  const db = SessionDb.open({ path: f.dbPath });
  try {
    const rows = db.loadMessages(String(f.events.at(-1)?.activeSessionId));
    expect(
      rows.some((row) =>
        row.content.some(
          (block) => block.type === 'tool_result' && block.tool_use_id === 'image-call',
        ),
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

test('native overflow compaction carries an old image into the child and resumed turn once', async () => {
  let calls = 0;
  const requests: ProviderRequest[] = [];
  const provider: LLMProvider = {
    name: 'grok',
    async *stream(request): AsyncGenerator<StreamEvent, AssistantMessage> {
      calls++;
      requests.push(request);
      if (calls === 1) throw new ContextOverflowError('grok');
      const answer = final(
        calls === 2 ? 'Earlier screenshot remains relevant.' : 'image inspected',
      );
      yield { type: 'assistant_message', message: answer };
      return answer;
    },
  };
  const f = fixture(provider);
  const db = SessionDb.open({ path: f.dbPath });
  const parent = db.createSession({ provider: 'grok', model: 'grok-4.7', platform: 'cli' });
  for (let n = 0; n < 10; n++)
    db.saveMessage(parent, {
      role: n % 2 ? 'assistant' : 'user',
      content: [
        { type: 'text', text: `History ${n} ${'irrelevant framing '.repeat(200)}` },
        ...(n === 0
          ? [
              {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: 'image/png',
                  data: png.toString('base64'),
                },
              },
            ]
          : []),
      ],
    });
  db.close();
  f.io.readStdin = async () =>
    JSON.stringify({ inputVersion: 1, text: 'Use the previous screenshot.' });
  expect(await runSdkRunCommand({ ...options, resume: parent }, f.io, f.deps)).toBe(0);
  expect(calls).toBe(3);
  const child = String(f.events.at(-1)?.activeSessionId);
  expect(child).not.toBe(parent);
  expect(images(requests[2]?.messages ?? [])).toHaveLength(1);
  expect(f.events.some((event) => event.type === 'compaction_complete')).toBe(true);
  expect(await runSdkRunCommand({ ...options, resume: child }, f.io, f.deps)).toBe(0);
  expect(images(requests[3]?.messages ?? [])).toHaveLength(1);
  const accounting = f.events.find((event) => event.type === 'context.accounting');
  expect(accounting).toMatchObject({ uncountedImages: 1, enforce: false });
  const reopened = SessionDb.open({ path: f.dbPath });
  try {
    expect(images(reopened.loadMessages(child))).toHaveLength(1);
  } finally {
    reopened.close();
  }
  expect(JSON.stringify(f.events)).not.toContain(png.toString('base64'));
});
