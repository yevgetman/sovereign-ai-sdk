// Repeatable website-build eval. A fixture builder replays the imperfect
// human prompt sequence and artifact validators capture regressions found in
// the Phase-10.5 real-world website run.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const WEBSITE_PROMPT_SEQUENCE = [
  'make me a simple website for a bike repair shop. keep it tasteful. put it in this folder',
  'make it feel more like a real local business, less generic',
  'polish the design but do not make it startup-y',
  'make sure it works well on a phone',
  'add a small javascript service estimator',
  'inspect it and fix obvious issues before calling it done',
  'rename the shop to Beacon Bike Works everywhere',
];

export type WebsiteEvalTranscriptTurn = {
  prompt: string;
  actions: string[];
};

export type WebsiteEvalSessionMetadata = {
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

export type WebsiteEvalBuilderResult = {
  transcript: WebsiteEvalTranscriptTurn[];
  sessionMetadata?: WebsiteEvalSessionMetadata;
};

export type WebsiteEvalBuilder = (input: {
  workspace: string;
  prompts: readonly string[];
}) => Promise<WebsiteEvalBuilderResult>;

export type WebsiteEvalCheck = {
  name: string;
  ok: boolean;
  details: string;
};

export type WebsiteEvalResult = {
  ok: boolean;
  workspace: string;
  prompts: string[];
  transcript: WebsiteEvalTranscriptTurn[];
  checks: WebsiteEvalCheck[];
  metadata: {
    createdAt: string;
    mode: 'fixture';
    promptCount: number;
    commands: string[];
    session: WebsiteEvalSessionMetadata | null;
  };
  resultPath: string;
};

export type RunWebsiteBuildEvalOptions = {
  workspace?: string;
  builder?: WebsiteEvalBuilder;
  now?: Date;
  sessionMetadata?: WebsiteEvalSessionMetadata;
  resultFilename?: string;
};

type ValidationResult = {
  checks: WebsiteEvalCheck[];
  commands: string[];
};

export async function runWebsiteBuildEval(
  options: RunWebsiteBuildEvalOptions = {},
): Promise<WebsiteEvalResult> {
  const workspace = resolve(
    options.workspace ?? mkdtempSync(join(tmpdir(), 'sovereign-website-eval-')),
  );
  mkdirSync(workspace, { recursive: true });

  const builder = options.builder ?? fixtureWebsiteBuilder;
  const builderResult = await builder({ workspace, prompts: WEBSITE_PROMPT_SEQUENCE });
  const validation = await validateWebsiteArtifact(workspace);
  const session = options.sessionMetadata ?? builderResult.sessionMetadata ?? null;
  const resultPath = join(workspace, options.resultFilename ?? 'website-eval-result.json');
  const checks = validation.checks;
  const result: WebsiteEvalResult = {
    ok: checks.every((check) => check.ok),
    workspace,
    prompts: [...WEBSITE_PROMPT_SEQUENCE],
    transcript: builderResult.transcript,
    checks,
    metadata: {
      createdAt: (options.now ?? new Date()).toISOString(),
      mode: 'fixture',
      promptCount: WEBSITE_PROMPT_SEQUENCE.length,
      commands: validation.commands,
      session,
    },
    resultPath,
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

export async function fixtureWebsiteBuilder(input: {
  workspace: string;
  prompts: readonly string[];
}): Promise<WebsiteEvalBuilderResult> {
  mkdirSync(input.workspace, { recursive: true });
  writeFileSync(join(input.workspace, 'index.html'), fixtureIndexHtml(), 'utf8');
  writeFileSync(join(input.workspace, 'style.css'), fixtureStyleCss(), 'utf8');
  writeFileSync(join(input.workspace, 'estimator.js'), fixtureEstimatorJs(), 'utf8');
  return {
    transcript: input.prompts.map((prompt, index) => ({
      prompt,
      actions:
        index === input.prompts.length - 1
          ? ['renamed artifact to Beacon Bike Works']
          : ['updated website artifact'],
    })),
    sessionMetadata: {
      sessionId: 'fixture',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    },
  };
}

export async function validateWebsiteArtifact(workspace: string): Promise<ValidationResult> {
  const root = resolve(workspace);
  const checks: WebsiteEvalCheck[] = [];
  const commands: string[] = [];

  const requiredFiles = ['index.html', 'style.css', 'estimator.js'];
  for (const file of requiredFiles) {
    const path = join(root, file);
    checks.push({
      name: `file exists: ${file}`,
      ok: existsSync(path),
      details: existsSync(path) ? path : `missing ${path}`,
    });
  }

  const jsCheck = await runCommand(root, ['node', '--check', 'estimator.js']);
  commands.push('node --check estimator.js');
  checks.push({
    name: 'javascript parses',
    ok: jsCheck.exitCode === 0,
    details: jsCheck.exitCode === 0 ? 'node --check passed' : jsCheck.output,
  });

  const serverCheck = await checkLocalServer(root);
  commands.push('local static server GET /');
  checks.push(serverCheck);

  const referenceCheck = checkLocalReferences(root);
  checks.push(referenceCheck);

  const renameCheck = checkRenameComplete(root);
  checks.push(renameCheck);

  return { checks, commands };
}

async function runCommand(
  cwd: string,
  command: string[],
): Promise<{ exitCode: number; output: string }> {
  try {
    const proc = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ]);
    return { exitCode, output: [stdout, stderr].filter(Boolean).join('\n').trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 127, output: message };
  }
}

async function checkLocalServer(root: string): Promise<WebsiteEvalCheck> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const requested = decodeURIComponent(
        url.pathname === '/' ? 'index.html' : url.pathname.slice(1),
      );
      const target = resolve(root, requested);
      if (target !== root && !target.startsWith(`${root}/`)) {
        return new Response('forbidden', { status: 403 });
      }
      if (!existsSync(target)) return new Response('not found', { status: 404 });
      return new Response(Bun.file(target));
    },
  });
  try {
    const response = await fetch(`http://${server.hostname}:${server.port}/`);
    return {
      name: 'local server returns 200',
      ok: response.status === 200,
      details: `GET / returned ${response.status}`,
    };
  } finally {
    server.stop(true);
  }
}

function checkLocalReferences(root: string): WebsiteEvalCheck {
  const htmlPath = join(root, 'index.html');
  if (!existsSync(htmlPath)) {
    return { name: 'local references exist', ok: false, details: 'index.html missing' };
  }
  const html = readFileSync(htmlPath, 'utf8');
  const missing: string[] = [];
  for (const ref of extractHtmlReferences(html)) {
    const local = normalizeLocalReference(ref);
    if (local === null) continue;
    if (!existsSync(resolve(root, local))) missing.push(ref);
  }
  return {
    name: 'local references exist',
    ok: missing.length === 0,
    details: missing.length === 0 ? 'all local references exist' : `missing: ${missing.join(', ')}`,
  };
}

function checkRenameComplete(root: string): WebsiteEvalCheck {
  const files = ['index.html', 'style.css', 'estimator.js'];
  const text = files
    .filter((file) => existsSync(join(root, file)))
    .map((file) => readFileSync(join(root, file), 'utf8'))
    .join('\n');
  const hasBeacon = text.includes('Beacon Bike Works');
  const hasOldName = /Ironclad|Old Bike|Generic Bike/i.test(text);
  return {
    name: 'late rename complete',
    ok: hasBeacon && !hasOldName,
    details:
      hasBeacon && !hasOldName
        ? 'Beacon Bike Works present; old names absent'
        : 'rename incomplete',
  };
}

function extractHtmlReferences(html: string): string[] {
  const refs: string[] = [];
  const pattern = /\b(?:href|src)=["']([^"']+)["']/g;
  for (const match of html.matchAll(pattern)) {
    if (match[1]) refs.push(match[1]);
  }
  return refs;
}

function normalizeLocalReference(ref: string): string | null {
  const trimmed = ref.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith('#') ||
    /^(https?:|mailto:|tel:|data:|javascript:)/i.test(trimmed)
  ) {
    return null;
  }
  const withoutFragment = trimmed.split('#', 1)[0] ?? trimmed;
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment;
  return withoutQuery.startsWith('/') ? withoutQuery.slice(1) : withoutQuery;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function fixtureIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Beacon Bike Works</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="#">Beacon Bike Works</a>
      <nav><a href="#services">Services</a><a href="#estimate">Estimate</a></nav>
    </header>
    <main>
      <section class="hero">
        <p class="eyebrow">Neighborhood bicycle repair</p>
        <h1>Beacon Bike Works keeps daily riders rolling.</h1>
        <p>Repairs, tuneups, and honest advice from a local bench in the heart of town.</p>
      </section>
      <section id="services">
        <h2>Shop Services</h2>
        <ul>
          <li>Safety check</li>
          <li>Flat repair</li>
          <li>Commuter tune</li>
        </ul>
      </section>
      <section id="estimate">
        <h2>Service Estimator</h2>
        <label><input type="checkbox" value="flat"> Flat repair</label>
        <label><input type="checkbox" value="tune"> Commuter tune</label>
        <output id="estimate-total">$0</output>
      </section>
    </main>
    <footer>Beacon Bike Works - open Tuesday through Saturday</footer>
    <script src="estimator.js"></script>
  </body>
</html>
`;
}

function fixtureStyleCss(): string {
  return `body {
  margin: 0;
  font-family: Arial, sans-serif;
  color: #18211f;
  background: #f6f2ea;
}

.site-header {
  display: flex;
  justify-content: space-between;
  padding: 16px 20px;
  background: #173f35;
  color: white;
}

.brand,
nav a {
  color: inherit;
  text-decoration: none;
}

.hero,
main section {
  padding: 32px 20px;
  max-width: 820px;
  margin: 0 auto;
}

@media (max-width: 560px) {
  .site-header {
    display: block;
  }
}
`;
}

function fixtureEstimatorJs(): string {
  return `const prices = {
  flat: 24,
  tune: 95
};

const total = document.querySelector('#estimate-total');
const boxes = Array.from(document.querySelectorAll('#estimate input[type="checkbox"]'));

function updateEstimate() {
  const amount = boxes
    .filter((box) => box.checked)
    .reduce((sum, box) => sum + (prices[box.value] || 0), 0);
  total.textContent = '$' + amount;
}

for (const box of boxes) {
  box.addEventListener('change', updateEstimate);
}

updateEstimate();
`;
}

function parseArgs(argv: string[]): { workspace?: string; resultFilename?: string } {
  const out: { workspace?: string; resultFilename?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workspace') {
      const value = argv[++i];
      if (value !== undefined) out.workspace = value;
      continue;
    }
    if (arg === '--result-filename') {
      const value = argv[++i];
      if (value !== undefined) out.resultFilename = value;
    }
  }
  return out;
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const result = await runWebsiteBuildEval(args);
  const failed = result.checks.filter((check) => !check.ok);
  process.stdout.write(
    [
      `website eval: ${result.ok ? 'passed' : 'failed'}`,
      `workspace: ${result.workspace}`,
      `result: ${result.resultPath}`,
      ...failed.map((check) => `failed ${check.name}: ${check.details}`),
    ].join('\n'),
  );
  process.stdout.write('\n');
  process.exit(result.ok ? 0 : 1);
}
