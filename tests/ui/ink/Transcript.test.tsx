import { describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';
import { Transcript } from '../../../src/ui/ink/Transcript.js';
import type { TranscriptMessage } from '../../../src/ui/ink/state/types.js';

describe('Transcript', () => {
  it('renders user, assistant, and tool messages in order', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', text: 'list src/' },
      { role: 'tool_use', toolName: 'Bash', input: { command: 'ls src/' } },
      { role: 'tool_result', toolUseId: 'tu_1', content: 'foo.ts bar.ts' },
      { role: 'assistant', text: 'You have two files: foo.ts, bar.ts.' },
    ];
    const { lastFrame } = render(<Transcript messages={messages} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('list src/');
    expect(out).toContain('Bash');
    expect(out).toContain('foo.ts');
    expect(out).toContain('two files');
  });

  it('renders empty state cleanly', () => {
    const { lastFrame } = render(<Transcript messages={[]} />);
    expect(lastFrame()).toBeDefined();
  });
});
