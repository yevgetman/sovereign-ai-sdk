import { describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';
import { Prompt } from '../../../src/ui/ink/Prompt.js';

// useInput attaches its listener inside useEffect, so we need to await a
// microtask boundary after render() before writing to stdin. Same applies
// after each write so the resulting setState flushes into a new frame.
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('Prompt', () => {
  it('echoes typed characters into the input buffer', async () => {
    const { stdin, lastFrame } = render(<Prompt onSubmit={() => {}} onAbort={() => {}} />);
    await flush();
    stdin.write('hello');
    await flush();
    expect(lastFrame() ?? '').toContain('hello');
  });

  it('calls onSubmit with the buffered text on Enter and clears the buffer', async () => {
    let submitted = '';
    const { stdin, lastFrame } = render(
      <Prompt
        onSubmit={(t) => {
          submitted = t;
        }}
        onAbort={() => {}}
      />,
    );
    await flush();
    stdin.write('hi there');
    await flush();
    stdin.write('\r'); // Enter
    await flush();
    expect(submitted).toBe('hi there');
    expect(lastFrame() ?? '').not.toContain('hi there');
  });

  it('calls onAbort when Ctrl-C is pressed', async () => {
    let aborted = false;
    const { stdin } = render(
      <Prompt
        onSubmit={() => {}}
        onAbort={() => {
          aborted = true;
        }}
      />,
    );
    await flush();
    stdin.write('\x03'); // Ctrl-C
    await flush();
    expect(aborted).toBe(true);
  });
});
