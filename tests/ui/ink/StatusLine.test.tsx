import { describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';
import { StatusLine } from '../../../src/ui/ink/StatusLine.js';

describe('StatusLine', () => {
  it('renders cwd, profile, provider, model, and cost', () => {
    const { lastFrame } = render(
      <StatusLine
        statusLine={{
          cwd: '/Users/julie/code/sovereign-ai-harness',
          profile: 'default',
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          sessionCostUsd: 0.42,
        }}
        status="idle"
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('default');
    expect(out).toContain('anthropic');
    expect(out).toContain('claude-opus-4-7');
    expect(out).toContain('$0.42');
  });

  it('shows a "thinking" indicator when status is thinking', () => {
    const { lastFrame } = render(
      <StatusLine statusLine={{ cwd: '.', profile: 'default' }} status="thinking" />,
    );
    expect(lastFrame() ?? '').toMatch(/thinking|⠋|·|·/);
  });
});
