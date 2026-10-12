// Controlled public long-history/resume fixture. Four live requests maximum.
// No workflow action executes; the provider only returns three public labels.
import { readFile, writeFile } from 'node:fs/promises';
import { resolveSkillContextBudget } from '../../packages/sdk/src/skills/budget.js';
import {
  InMemorySkillContinuityStore,
  createSkillContinuity,
} from '../../packages/sdk/src/skills/continuity.js';

const args = process.argv.slice(2);
const arg = (name: string): string => {
  const at = args.indexOf(name);
  const value = args[at + 1];
  if (at < 0 || !value) throw new Error(`Required ${name}`);
  return value;
};
if (!args.includes('--live'))
  throw new Error('Explicit --live required; max four requests, 192 output tokens each');
const config = JSON.parse(await readFile(arg('--config'), 'utf8'));
const catalog = JSON.parse(await readFile(arg('--catalog-report'), 'utf8'));
const nativeKey = config.providers?.anthropic?.apiKey;
const routerKey = config.providers?.openrouter?.apiKey;
if (!nativeKey || !routerKey) throw new Error('Two configured providers required');
const steps = ['CHECK_ARTIFACT', 'VERIFY_SIGNATURE', 'RECORD_PUBLICATION'];
const workflow = `This is a read-only release simulation. When asked to continue the release drill, respond with exactly these three labels in order, one per line: ${steps.join(', ')}. Do not execute any release action.`;
const original = [{ role: 'user', content: workflow }];
for (let i = 0; i < 40; i++) {
  original.push({
    role: 'assistant',
    content: `Inventory note ${i}: ${'Public fixture stock and release drill notes. '.repeat(20)}`,
  });
  original.push({
    role: 'user',
    content: `Recorded inventory note ${i}. Continue recording before resuming the release drill.`,
  });
}
const latest = {
  role: 'user',
  content:
    'Continue the release drill from our earlier workflow. Give only its three required labels.',
};
original.push(latest);
// Deterministic forced reduction drops workflow text and keeps the latest task.
const reduced = [
  { role: 'user', content: 'Summary: inventory notes were recorded during a release drill.' },
  { role: 'assistant', content: 'Inventory is recorded.' },
  latest,
];
const store = new InMemorySkillContinuityStore();
const scope = { profile: 'public-eval', owner: 'fixture', session: 'fixture' };
const first = createSkillContinuity({ scope, store });
await first.activated(
  {
    name: 'release',
    revision: 'a'.repeat(64),
    source: 'user',
    args: '',
    allowedTools: ['Read'],
    allowedResourceRoots: [],
  },
  workflow,
  'initial-turn',
);
await first.finish('initial-turn', 'succeeded');
const resumed = createSkillContinuity({ scope, store });
const budgetProbe = await resumed.guidance({
  budget: resolveSkillContextBudget({ contextWindowTokens: 256 }),
  turnId: 'bounded-probe',
});
const rows: unknown[] = [];
let requests = 0;
for (const model of catalog.models.slice(0, 2)) {
  const retained = await resumed.guidance({
    budget: resolveSkillContextBudget({ contextWindowTokens: model.window, outputTokens: 192 }),
    turnId: 'resumed-turn',
    resolveRevision: async () => 'a'.repeat(64),
  });
  for (const mode of ['summary-only', 'continuity'] as const) {
    if (++requests > 4) throw new Error('request cap reached');
    const system =
      'You are a careful assistant. Follow the recorded workflow when it is available.';
    const messages = reduced.map((message, index) =>
      mode === 'continuity' && index === reduced.length - 1
        ? { ...message, content: `${retained.text}\n${message.content}` }
        : message,
    );
    const started = performance.now();
    const native = model.provider === 'anthropic';
    const response = await fetch(
      native
        ? 'https://api.anthropic.com/v1/messages'
        : 'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: native
          ? {
              'x-api-key': nativeKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            }
          : { authorization: `Bearer ${routerKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(
          native
            ? { model: model.id, max_tokens: 192, system, messages }
            : {
                model: model.id,
                max_tokens: 192,
                messages: [{ role: 'system', content: system }, ...messages],
              },
        ),
      },
    );
    if (!response.ok) throw new Error(`Provider request rejected: HTTP ${response.status}`);
    const result = await response.json();
    const text = native
      ? result.content
          .filter((block: { type: string }) => block.type === 'text')
          .map((block: { text: string }) => block.text)
          .join('\n')
      : (result.choices?.[0]?.message?.content ?? '');
    const positions = steps.map((step) => text.indexOf(step));
    const matched = positions.filter((position) => position >= 0).length;
    const inputTokens = native
      ? (result.usage?.input_tokens ?? 0)
      : (result.usage?.prompt_tokens ?? 0);
    const outputTokens = native
      ? (result.usage?.output_tokens ?? 0)
      : (result.usage?.completion_tokens ?? 0);
    rows.push({
      provider: model.provider,
      model: model.id,
      mode,
      requiredSteps: 3,
      matchedSteps: matched,
      ordered:
        matched === 3 &&
        positions.every(
          (position, index) => index === 0 || position > (positions[index - 1] ?? -1),
        ),
      inputTokens,
      outputTokens,
      elapsedMs: Math.round(performance.now() - started),
      costUsd:
        result.usage?.cost ??
        (model.pricing
          ? inputTokens * Number(model.pricing.prompt) +
            outputTokens * Number(model.pricing.completion)
          : null),
      costKind: native ? 'catalog-estimate' : 'provider-reported',
      retained: mode === 'continuity' ? retained.retained : 0,
      dropped: mode === 'continuity' ? retained.dropped : 1,
    });
  }
}
const report = {
  date: new Date().toISOString(),
  scope:
    'Public manufactured long-history fixture; deterministic forced summary, fresh continuity manager resume, one repetition/provider. Four live requests; no tools or release actions. Not a production long-turn or longitudinal quality claim.',
  originalMessages: original.length,
  originalBytes: Buffer.byteLength(JSON.stringify(original)),
  reducedMessages: reduced.length,
  reducedBytes: Buffer.byteLength(JSON.stringify(reduced)),
  requests,
  rows,
  activationSource: 'user',
  selectionReason: 'explicit public workflow activation',
  lifetime: 'session',
  guidanceRole: 'user',
  smallWindowProbe: { retained: budgetProbe.retained, dropped: budgetProbe.dropped },
  diagnostics: [...first.diagnostics(), ...resumed.diagnostics()],
};
await writeFile(arg('--out'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ requests, rows, output: arg('--out') }));
