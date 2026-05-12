// Phase 16.0c SD1 — verifies runDispatch() reads slash commands from a
// piped stdin, prints output framed by --- end-of-turn --- markers, and
// exits cleanly on EOF and on /quit. Uses in-process invocation with a
// stream-pair shim so we don't need to spawn the CLI binary.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { READY_MARKER, TURN_SEPARATOR, runDispatch } from '../../src/cli/dispatchCommand.js';

let home: string;
let savedHome: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-cmd-'));
  savedHome = process.env.HARNESS_HOME;
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.HARNESS_HOME = home;
  if (savedKey === undefined) process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
  if (savedHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHome;
  // biome-ignore lint/performance/noDelete: process.env requires `delete` to truly unset a key.
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  rmSync(home, { recursive: true, force: true });
});

/** Collect every chunk written to a stream into a single string. */
function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

describe('runDispatch', () => {
  test('prints ready marker, dispatches /help and /about, separates turns, exits on EOF', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdoutPromise = collectStream(stdout);

    stdin.write('/help\n');
    stdin.write('/about\n');
    stdin.end();

    const exitCode = await runDispatch({ stdin, stdout });
    stdout.end();
    const output = await stdoutPromise;

    expect(exitCode).toBe(0);
    expect(output).toContain(READY_MARKER);
    expect(output).toContain('slash commands'); // from /help
    expect(output).toContain('harness home:'); // from /about

    // Two turns, two separators.
    const separatorCount = output.split(TURN_SEPARATOR).length - 1;
    expect(separatorCount).toBe(2);
  });

  test('exits cleanly after /quit, ignoring any subsequent input', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdoutPromise = collectStream(stdout);

    stdin.write('/quit\n');
    // These lines arrive after /quit set exitRequested; the loop should
    // break before reading them. The stream is still ended so the test
    // doesn't hang.
    stdin.write('/help\n');
    stdin.end();

    const exitCode = await runDispatch({ stdin, stdout });
    stdout.end();
    const output = await stdoutPromise;

    expect(exitCode).toBe(0);
    expect(output).toContain(READY_MARKER);
    // /help would inject 'slash commands' if it ran. It must not.
    expect(output).not.toContain('slash commands');
  });

  test('handles unknown commands without exiting non-zero', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdoutPromise = collectStream(stdout);

    stdin.write('/bogus\n');
    stdin.end();

    const exitCode = await runDispatch({ stdin, stdout });
    stdout.end();
    const output = await stdoutPromise;

    expect(exitCode).toBe(0);
    expect(output).toContain('unknown command');
    expect(output).toContain(TURN_SEPARATOR);
  });

  test('skips blank lines without emitting a separator', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdoutPromise = collectStream(stdout);

    stdin.write('\n\n   \n');
    stdin.write('/help\n');
    stdin.end();

    const exitCode = await runDispatch({ stdin, stdout });
    stdout.end();
    const output = await stdoutPromise;

    expect(exitCode).toBe(0);
    // Only one real command — only one separator.
    const separatorCount = output.split(TURN_SEPARATOR).length - 1;
    expect(separatorCount).toBe(1);
  });
});
