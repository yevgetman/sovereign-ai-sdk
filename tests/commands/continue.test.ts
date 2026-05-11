// Unit tests for the /continue slash command.

import { describe, expect, test } from 'bun:test';
import { COMMANDS } from '../../src/commands/registry.js';
import { makeCtx } from './_makeCtx.js';

function findContinueCommand() {
  const cmd = COMMANDS.find((c) => c.name === 'continue');
  if (!cmd || cmd.type !== 'local') throw new Error('/continue not found as local command');
  return cmd;
}

describe('/continue command', () => {
  test('returns "no pending checkin" when resumeCheckin is undefined', async () => {
    const cmd = findContinueCommand();
    const ctx = makeCtx();
    const output = await cmd.call('', ctx);
    expect(output).toContain('no pending checkin');
  });

  test('calls resumeCheckin and returns empty string when checkin is pending', async () => {
    const cmd = findContinueCommand();
    let resumed = false;
    const ctx = makeCtx({
      resumeCheckin: async () => {
        resumed = true;
      },
    });
    const output = await cmd.call('', ctx);
    expect(resumed).toBe(true);
    expect(output).toBe('');
  });

  test('/continue is registered in COMMANDS array', () => {
    const cmd = COMMANDS.find((c) => c.name === 'continue');
    expect(cmd).toBeDefined();
    expect(cmd?.type).toBe('local');
  });
});
