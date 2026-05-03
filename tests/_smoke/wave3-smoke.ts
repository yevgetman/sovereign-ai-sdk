// Wave-3 visual smoke. Renders the same surface set under each of
// the three built-in themes so a human can eyeball the contrast.
// Run with: bun run tests/_smoke/wave3-smoke.ts

import chalk from 'chalk';
import { ContextMeter } from '../../src/ui/contextMeter.js';
import { renderToolDiff } from '../../src/ui/diff.js';
import { type FooterInfo, renderFooter } from '../../src/ui/footer.js';
import { renderFrame } from '../../src/ui/modal.js';
import { renderSplash } from '../../src/ui/splash.js';
import { __resetForTests, listThemes, setTheme, theme } from '../../src/ui/theme.js';

function header(label: string): void {
  console.log(`\n${chalk.bold.cyan('═══')} ${chalk.bold(label)} ${chalk.bold.cyan('═══')}\n`);
}

function showSurfacesUnderActiveTheme(): void {
  console.log(theme.tokens.textDim(`(${theme.name} — ${theme.tokens.text(theme.name)})`));

  // Footer in 3 zones
  const meter = new ContextMeter({ contextLength: 200_000 });
  const baseFooter: FooterInfo = {
    providerName: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    bundleLabel: 'sovereign-ai-docs',
    permissionMode: 'ask',
    toolCount: 14,
    costUsd: 0.034,
    meter,
  };
  meter.update({ inputTokens: 30_000, outputTokens: 5_000 });
  console.log(renderFooter(baseFooter));
  meter.update({ inputTokens: 130_000 });
  console.log(renderFooter(baseFooter));
  meter.update({ inputTokens: 170_000 });
  console.log(renderFooter(baseFooter));
  console.log();

  // Permission modal
  const modal = renderFrame(
    'permission required',
    [
      { label: 'tool', value: theme.tokens.textBold('Bash') },
      { label: 'input', value: 'rm -rf node_modules' },
      { label: 'reason', value: theme.tokens.textMuted('writes to project root') },
    ],
    [
      { key: 'y', label: 'allow' },
      { key: 'n', label: 'deny', default: true },
      { key: 'a', label: 'always' },
    ],
    theme.tokens.borderWarning,
  );
  console.log(modal.join('\n'));
  console.log();

  // FileEdit diff with line context
  console.log(
    renderToolDiff(
      'FileEdit',
      { path: 'src/example.ts', old_string: 'hello world', new_string: 'hello sovereign' },
      {
        verbose: false,
        preContent: 'const greeting = "hello world";\nconsole.log(greeting);\n',
      },
    ),
  );

  // Splash card (just the right-side info, not the logo)
  console.log(
    renderSplash({
      providerLabel: 'anthropic',
      authLabel: theme.tokens.textMuted('API Key'),
      model: 'claude-haiku-4-5-20251001',
      bundlePath: '/Users/julie/code/sovereign-ai-docs',
      permissionMode: 'ask',
      permissionModeNote: '',
      toolCount: 14,
      cacheOn: true,
      sessionLabel: 'new abc12345',
      exitHint: '/quit or Ctrl-D to exit',
    }),
  );
}

for (const t of listThemes()) {
  header(`theme: ${t.name}`);
  setTheme(t.name);
  showSurfacesUnderActiveTheme();
}

// Reset for any further consumers in the same process.
__resetForTests();
