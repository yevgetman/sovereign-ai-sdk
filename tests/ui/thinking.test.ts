import { describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import { withModal } from '../../src/ui/modal.js';
import { ThinkingIndicator } from '../../src/ui/thinking.js';

chalk.level = 1;

class StringSink {
  out = '';
  write(chunk: string): boolean {
    this.out += chunk;
    return true;
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('ThinkingIndicator', () => {
  test('does not render before the 500ms grace period', async () => {
    const sink = new StringSink();
    const ind = new ThinkingIndicator(sink);
    ind.start();
    await delay(100);
    ind.stop();
    expect(sink.out).toBe('');
  });

  test('renders a Thinking line after the grace period', async () => {
    const sink = new StringSink();
    const ind = new ThinkingIndicator(sink);
    ind.start();
    await delay(620);
    ind.stop();
    expect(strip(sink.out)).toContain('Thinking');
  });

  test('updates token counts when usage is set', async () => {
    const sink = new StringSink();
    const ind = new ThinkingIndicator(sink);
    ind.start();
    ind.setUsage(1234, 56);
    await delay(620);
    ind.stop();
    const text = strip(sink.out);
    expect(text).toContain('↑ 1234');
    expect(text).toContain('↓ 56');
  });

  test('streamed-char count rolls into the output token estimate', async () => {
    const sink = new StringSink();
    const ind = new ThinkingIndicator(sink);
    ind.start();
    ind.noteStreamedChars(800); // ~200 tokens at chars/4
    await delay(620);
    ind.stop();
    expect(strip(sink.out)).toContain('↓ 200');
  });

  test('stop clears the rendered line via \\r + ANSI clear', async () => {
    const sink = new StringSink();
    const ind = new ThinkingIndicator(sink);
    ind.start();
    await delay(620);
    const beforeStop = sink.out.length;
    ind.stop();
    const afterStop = sink.out.slice(beforeStop);
    expect(afterStop).toContain('\r');
    expect(afterStop).toContain(`${ESC}[2K`);
  });

  test('start() is idempotent; calling it twice is a no-op', () => {
    const sink = new StringSink();
    const ind = new ThinkingIndicator(sink);
    ind.start();
    const len = sink.out.length;
    ind.start();
    expect(sink.out.length).toBe(len);
    ind.stop();
  });

  test('single running tool surfaces as "Running Name(args) · Ns"', async () => {
    const sink = new StringSink();
    const ind = new ThinkingIndicator(sink);
    ind.start();
    ind.addRunningTool('id-1', 'Bash', 'find / -name "*.ts"');
    await delay(620);
    ind.stop();
    const text = strip(sink.out);
    expect(text).toContain('Running');
    expect(text).toContain('Bash');
    expect(text).toContain('find /');
    // Single-tool case should NOT use the "N tools" plural form.
    expect(text).not.toMatch(/Running \d+ tools/);
  });

  test('multiple running tools surface as "Running N tools · A, B, C · Ns"', async () => {
    const sink = new StringSink();
    const ind = new ThinkingIndicator(sink);
    ind.start();
    ind.addRunningTool('id-1', 'FileRead', 'src/auth.py');
    ind.addRunningTool('id-2', 'Grep', '"foo"');
    ind.addRunningTool('id-3', 'Glob', '*.ts');
    await delay(620);
    ind.stop();
    const text = strip(sink.out);
    expect(text).toContain('Running 3 tools');
    expect(text).toContain('FileRead');
    expect(text).toContain('Grep');
    expect(text).toContain('Glob');
  });

  test('reverts to "Thinking" once all tools complete', async () => {
    const sink = new StringSink();
    const ind = new ThinkingIndicator(sink);
    ind.start();
    ind.addRunningTool('id-1', 'Bash', 'ls');
    ind.removeRunningTool('id-1');
    await delay(620);
    ind.stop();
    const text = strip(sink.out);
    expect(text).toContain('Thinking');
    expect(text).not.toContain('Running');
  });

  test('does not render while a modal is active (prompt is sacred)', async () => {
    const indSink = new StringSink();
    const modalSink = new StringSink();
    const ind = new ThinkingIndicator(indSink);
    ind.start();
    // Wait past the grace period; tick fires but the modal blocks render.
    await withModal({
      title: 't',
      rows: [],
      choices: [],
      parse: () => 'ok',
      question: async () => {
        await delay(620);
        return 'ok';
      },
      out: modalSink,
    });
    ind.stop();
    expect(indSink.out).toBe('');
  });
});
