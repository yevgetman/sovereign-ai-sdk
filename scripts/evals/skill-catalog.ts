/** Public-fixture behavioral evaluation. Never runs in the test gate.
 * bun scripts/evals/skill-catalog.ts --live --config PATH --out PATH
 * Explicit opt-in; max 24 model requests and 192 output tokens/request.
 * Provider credentials are read from the requested config and never saved.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { buildSkillCatalogIndex } from '../../packages/sdk/src/skills/catalog.js';
import { resolveSkillContextBudget } from '../../packages/sdk/src/skills/budget.js';
import type { Skill } from '../../packages/sdk/src/skills/types.js';

const argv = process.argv.slice(2);
const arg = (name: string) => argv[argv.indexOf(name) + 1];
if (!argv.includes('--live') || !argv.includes('--config') || !argv.includes('--out'))
  throw new Error(
    'Explicit --live --config PATH --out PATH required. Max 24 requests, 192 output tokens/request.',
  );
const config = JSON.parse(await readFile(arg('--config')!, 'utf8'));
const fetchJson = async (url: string, init: RequestInit = {}) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const reason = String(body.error?.message ?? body.error?.type ?? 'request rejected').slice(
      0,
      240,
    );
    throw new Error(
      `Provider request failed with HTTP ${response.status}: ${reason.replaceAll(nativeKey ?? '', '<credential>').replaceAll(routerKey ?? '', '<credential>')}`,
    );
  }
  return response.json();
};
const nativeKey = config.providers?.anthropic?.apiKey;
const routerKey = config.providers?.openrouter?.apiKey;
if (typeof nativeKey !== 'string' || typeof routerKey !== 'string')
  throw new Error('Both native Anthropic and OpenRouter credentials required');
const [nativeCatalog, routerCatalog] = await Promise.all([
  fetchJson('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': nativeKey, 'anthropic-version': '2023-06-01' },
  }),
  fetchJson('https://openrouter.ai/api/v1/models'),
]);
const native = nativeCatalog.data.find((r: { id: string }) => r.id.includes('haiku'));
if (!native) throw new Error('No eligible currently advertised native Haiku model');
const nativePricing = routerCatalog.data.find(
  (r: { id: string }) => r.id === `anthropic/${native.id.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`,
)?.pricing;
const router = routerCatalog.data
  .filter(
    (r: {
      id: string;
      supported_parameters?: string[];
      architecture?: { output_modalities?: string[] };
      pricing?: { prompt?: string; completion?: string };
    }) =>
      r.id.startsWith('openai/') &&
      !r.id.includes(':') &&
      r.supported_parameters?.includes('tools') &&
      r.architecture?.output_modalities?.includes('text') &&
      Number(r.pricing?.prompt) > 0 &&
      Number(r.pricing?.completion) > 0,
  )
  .sort(
    (
      a: { pricing: { prompt: string; completion: string } },
      b: { pricing: { prompt: string; completion: string } },
    ) =>
      Number(a.pricing.prompt) +
      Number(a.pricing.completion) -
      Number(b.pricing.prompt) -
      Number(b.pricing.completion),
  )[0];
if (!native || !router) throw new Error('No eligible current cheap model in provider catalogs');
const fixtureRows = [
  [
    'release',
    'Publish a planned software release with verification.',
    'When the user asks to release software.',
  ],
  [
    'review',
    'Review a code diff and report confirmed defects.',
    'When the user asks to review code changes.',
  ],
  [
    'transcribe',
    'Transcribe an audio recording with speaker labels.',
    'When the user provides a meeting recording.',
  ],
  [
    'invoice',
    'Prepare an itemized client invoice from supplied work.',
    'When the user asks for an invoice.',
  ],
  [
    'diagram',
    'Draw a system diagram from architecture facts.',
    'When the user asks for a system diagram.',
  ],
  [
    'translate',
    'Translate supplied prose while retaining its meaning.',
    'When the user asks to translate text.',
  ],
];
const fixtures = fixtureRows.map(([name, description, whenToUse]) => ({
  name: name!,
  description: description!,
  whenToUse: whenToUse!,
  allowedTools: [],
  path: '',
  realpath: '',
  dir: '',
  source: 'bundle',
  trustTier: 'builtin',
  allowShellInterpolation: false,
  metadata: {
    harness: {
      requiresTools: [],
      requiresToolsets: [],
      fallbackForTools: [],
      fallbackForToolsets: [],
    },
  },
  guard: { action: 'allow', findings: [] },
  body: '',
})) satisfies Skill[];
const cases = [
  {
    id: 'implicit-review',
    task: 'Inspect this code patch for defects and report the concrete problems.',
    expected: 'review',
  },
  {
    id: 'implicit-release',
    task: 'Ship the planned software version and verify its public artifacts.',
    expected: 'release',
  },
  {
    id: 'implicit-audio',
    task: 'Turn this meeting recording into a transcript with each speaker named.',
    expected: 'transcribe',
  },
  { id: 'negative', task: 'What is 6 multiplied by 7?', expected: null },
];
const tools = [
  {
    name: 'skills_list',
    description:
      'Search the available skill metadata. Returns names, descriptions and trigger predicates.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'skill',
    description: 'Activate a relevant named skill before completing its workflow.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];
const rows: any[] = [];
const unavailableProviders = new Set<string>();
let requests = 0;
let reservedCostUsd = 0;
const maxCostUsd = 1;
const models = [
  {
    provider: 'anthropic',
    id: native.id,
    window: native.max_input_tokens,
    price: nativePricing,
    priceSource:
      'https://openrouter.ai/api/v1/models (native rate cross-check: https://www.anthropic.com/claude/haiku)',
  },
  {
    provider: 'openrouter',
    id: router.id,
    window: router.context_length,
    price: router.pricing,
    priceSource: 'https://openrouter.ai/api/v1/models',
  },
];
for (const model of models)
  for (const mode of ['reminder', 'metadata'] as const)
    for (const test of cases) {
      if (unavailableProviders.has(model.provider)) continue;
      const start = performance.now();
      const indexStart = performance.now();
      const index = buildSkillCatalogIndex(fixtures, {
        budget: resolveSkillContextBudget({ contextWindowTokens: model.window, outputTokens: 192 }),
      });
      const indexMs = performance.now() - indexStart;
      const system = `You are an assistant. Use relevant skills for specialized workflows. Do not activate a skill for an unrelated task.\n${mode === 'metadata' ? index.text : '<skills>Use skills_list at the start of each task to see available skills. Use skill_view to inspect full skill bodies or reference files before following a skill.</skills>'}`;
      const nativeMessages: unknown[] = [{ role: 'user', content: test.task }];
      const routerMessages: unknown[] = [
        { role: 'system', content: system },
        { role: 'user', content: test.task },
      ];
      let selected: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;
      let costReported = 0;
      let calls = 0;
      let listCalls = 0;
      let error: string | undefined;
      try {
        for (let turn = 0; turn < 2; turn++) {
          if (requests >= 24) throw new Error('24-request evaluation cap reached');
          if (
            !model.price ||
            !Number.isFinite(Number(model.price.prompt)) ||
            !Number.isFinite(Number(model.price.completion))
          )
            throw new Error('Current publisher pricing required for bounded paid evaluation');
          const inputBound =
            new TextEncoder().encode(
              JSON.stringify({
                system,
                messages: model.provider === 'anthropic' ? nativeMessages : routerMessages,
                tools,
              }),
            ).byteLength + 512;
          const reservation =
            inputBound * Number(model.price.prompt) + 192 * Number(model.price.completion);
          if (reservedCostUsd + reservation > maxCostUsd)
            throw new Error('$1 evaluation reservation cap reached');
          reservedCostUsd += reservation;
          requests++;
          calls++;
          if (model.provider === 'anthropic') {
            const reply = await fetchJson('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'x-api-key': nativeKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                model: model.id,
                max_tokens: 192,
                system,
                messages: nativeMessages,
                tools,
              }),
            });
            inputTokens += reply.usage?.input_tokens ?? 0;
            outputTokens += reply.usage?.output_tokens ?? 0;
            const activations = reply.content.filter(
              (b: { type: string; name?: string }) => b.type === 'tool_use' && b.name === 'skill',
            );
            if (activations.length) {
              selected = activations[0].input?.name ?? null;
              break;
            }
            const lists = reply.content.filter(
              (b: { type: string; name?: string }) =>
                b.type === 'tool_use' && b.name === 'skills_list',
            );
            if (!lists.length) break;
            listCalls += lists.length;
            nativeMessages.push(
              { role: 'assistant', content: reply.content },
              {
                role: 'user',
                content: lists.map((b: { id: string; input?: { query?: string } }) => ({
                  type: 'tool_result',
                  tool_use_id: b.id,
                  content: JSON.stringify(
                    fixtureRows
                      .filter(
                        (r) =>
                          !b.input?.query ||
                          r.join(' ').toLowerCase().includes(b.input.query.toLowerCase()),
                      )
                      .map(([name, description, whenToUse]) => ({ name, description, whenToUse })),
                  ),
                })),
              },
            );
          } else {
            const reply = await fetchJson('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: { authorization: `Bearer ${routerKey}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                model: model.id,
                max_tokens: 192,
                messages: routerMessages,
                tools: tools.map((t) => ({
                  type: 'function',
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema,
                  },
                })),
              }),
            });
            inputTokens += reply.usage?.prompt_tokens ?? 0;
            outputTokens += reply.usage?.completion_tokens ?? 0;
            costReported += reply.usage?.cost ?? 0;
            const message = reply.choices?.[0]?.message;
            const toolCalls = message?.tool_calls ?? [];
            const activation = toolCalls.find(
              (t: { function: { name: string } }) => t.function.name === 'skill',
            );
            if (activation) {
              selected = JSON.parse(activation.function.arguments).name ?? null;
              break;
            }
            const lists = toolCalls.filter(
              (t: { function: { name: string } }) => t.function.name === 'skills_list',
            );
            if (!lists.length) break;
            listCalls += lists.length;
            routerMessages.push(message);
            for (const call of lists) {
              const query = JSON.parse(call.function.arguments).query?.toLowerCase();
              routerMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(
                  fixtureRows
                    .filter((r) => !query || r.join(' ').toLowerCase().includes(query))
                    .map(([name, description, whenToUse]) => ({ name, description, whenToUse })),
                ),
              });
            }
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : 'evaluation unavailable';
        unavailableProviders.add(model.provider);
      }
      rows.push({
        provider: model.provider,
        model: model.id,
        contextWindow: model.window,
        mode,
        case: test.id,
        expected: test.expected,
        selected,
        correct: !error && selected === test.expected,
        falseActivation: test.expected === null && selected !== null,
        requests: calls,
        discoveryCalls: listCalls,
        inputTokens,
        outputTokens,
        elapsedMs: Math.round(performance.now() - start),
        indexMs,
        systemBytes: new TextEncoder().encode(system).byteLength,
        costUsd:
          costReported ||
          (model.price
            ? inputTokens * Number(model.price.prompt) +
              outputTokens * Number(model.price.completion)
            : null),
        costKind: costReported ? 'provider-reported' : 'catalog-estimate',
        ...(error ? { error } : {}),
      });
    }
const report = {
  date: new Date().toISOString(),
  scope:
    'Public skill selection fixture only; no skill bodies executed, no private prompts, one repetition per case, not longitudinal certification.',
  maxRequests: 24,
  maxOutputTokensPerRequest: 192,
  maxCostUsd,
  reservedCostUsd,
  requests,
  models: models.map(({ price, ...model }) => ({ ...model, pricing: price })),
  rows,
};
await writeFile(arg('--out')!, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    requests,
    rows: rows.length,
    correct: rows.filter((r: any) => r.correct).length,
    errors: rows.filter((r: any) => r.error).length,
    output: arg('--out'),
  }),
);
