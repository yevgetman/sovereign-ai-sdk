// Wave-1 visual smoke test. Not a unit test — just renders the new
// surfaces so a human can eyeball them. Run with:
//   bun run tests/_smoke/wave1-smoke.ts
import chalk from 'chalk';
import { ContextMeter } from '../../src/ui/contextMeter.js';
import { renderToolDiff } from '../../src/ui/diff.js';
import { type FooterInfo, renderFooter } from '../../src/ui/footer.js';
import { renderFrame } from '../../src/ui/modal.js';

console.log('\n--- footer (ok zone) ---');
const meter = new ContextMeter({ contextLength: 200_000 });
meter.update({ inputTokens: 30_000, outputTokens: 5_000 });
const baseInfo: FooterInfo = {
  providerName: 'anthropic',
  model: 'claude-opus-4-7',
  bundleLabel: 'sovereign-ai-docs',
  permissionMode: 'ask',
  toolCount: 14,
  costUsd: 0.034,
  meter,
};
console.log(renderFooter(baseInfo));

console.log('\n--- footer (warn zone) ---');
meter.update({ inputTokens: 130_000 });
console.log(renderFooter(baseInfo));

console.log('\n--- footer (danger zone) ---');
meter.update({ inputTokens: 170_000 });
console.log(renderFooter(baseInfo));

console.log('\n--- modal frame (permission required) ---');
const lines = renderFrame(
  'permission required',
  [
    { label: 'tool', value: chalk.bold('Bash') },
    { label: 'input', value: 'rm -rf node_modules && bun install' },
    { label: 'reason', value: chalk.gray('writes to project root') },
  ],
  [
    { key: 'y', label: 'allow' },
    { key: 'n', label: 'deny', default: true },
    { key: 'a', label: 'always' },
  ],
  chalk.yellow,
);
console.log(lines.join('\n'));

console.log('\n--- diff: FileEdit substring-only (no preContent) ---');
console.log(
  renderToolDiff(
    'FileEdit',
    {
      path: 'src/example.ts',
      old_string: 'hello world',
      new_string: 'hello sovereign',
    },
    { verbose: false },
  ),
);

console.log('\n--- diff: FileEdit with line context (preContent provided) ---');
const seededFile =
  '// preamble\nconst greeting = "hello world";\nfunction main() {\n  console.log(greeting);\n}\n';
console.log(
  renderToolDiff(
    'FileEdit',
    {
      path: 'src/example.ts',
      old_string: 'hello world',
      new_string: 'hello sovereign',
    },
    { verbose: false, preContent: seededFile },
  ),
);

console.log('\n--- diff: FileEdit replace_all (multi-occurrence note) ---');
const multiFile = 'foo\nfoo bar\nbaz foo\nfoo\n';
console.log(
  renderToolDiff(
    'FileEdit',
    {
      path: 'data.txt',
      old_string: 'foo',
      new_string: 'qux',
      replace_all: true,
    },
    { verbose: true, preContent: multiFile },
  ),
);

console.log('\n--- diff: FileWrite long (non-verbose, truncates) ---');
const longContent = Array.from({ length: 18 }, (_, i) => `line-${i}`).join('\n');
console.log(
  renderToolDiff('FileWrite', { path: 'docs/notes.md', content: longContent }, { verbose: false }),
);
