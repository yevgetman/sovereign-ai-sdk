// Skill guard pattern coverage. The patterns blanket-block third-party
// skills that look dangerous; false positives silently disable legitimate
// skills, so each pattern needs both happy-path AND no-trigger coverage.

import { describe, expect, test } from 'bun:test';
import { guardSkillText } from '@yevgetman/sov-sdk/skills/guard';

describe('guardSkillText — destructive-operation patterns', () => {
  // The trust tier matters: cwd/.harness/skills/ and <harness-home>/skills/
  // both load at the 'trusted' tier (per src/skills/loader.ts). A critical
  // finding on a 'trusted' skill blocks outright — there is no 'ask' fall-
  // through for user-installed skills since Phase 13's loader unification.
  // The catch-all 'ask' branch in guard.ts now only fires for the
  // 'agent-created' tier (skills the model wrote into <home>/skills/agent-
  // created/), which is exercised in the trust-tier-semantics describe
  // block below.

  test('matches `rm -rf /` (intended catch)', () => {
    const decision = guardSkillText('Run rm -rf / to clean up.', 'trusted');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('matches `dd if=/dev/...` (intended catch)', () => {
    const decision = guardSkillText('Use dd if=/dev/zero of=/dev/sda', 'trusted');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('matches `shred ` as a command with arguments (intended catch)', () => {
    const decision = guardSkillText('Run shred -u sensitive.txt', 'trusted');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('does NOT match the noun "shredded" or shred used as a fragment', () => {
    // The previous \bshred\b matched "shred" anywhere (e.g. in narrative
    // text "the document was shredded"). Tightened to \bshred\s+ which
    // requires it to be a command verb followed by arguments.
    const decision = guardSkillText('The document was shredded.', 'trusted');
    expect(decision.findings.filter((f) => f.category === 'destructive-operation')).toEqual([]);
  });

  test('matches `format C:` Windows-style disk format (intended catch)', () => {
    const decision = guardSkillText('Run format C: to wipe', 'trusted');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('matches `format /dev/sda` Unix-style (intended catch)', () => {
    const decision = guardSkillText('Run format /dev/sda1', 'trusted');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('matches `mkfs.ext4 /dev/...` (intended catch)', () => {
    const decision = guardSkillText('Run mkfs.ext4 /dev/sdb1', 'trusted');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('does NOT match the word "format" used in non-command contexts', () => {
    // Regression: the previous \bformat\b pattern matched "format" anywhere,
    // which silently blocked any skill with a phrase like "in this format:"
    // or "the JSON format is:". Caught by the skill-args-propagate-to-prompt
    // semantic case, where the echo-args skill body contained
    // 'reply with this exact format:' and was silently blocked from loading.
    const cases = [
      'Reply with one line in this exact format: "echoed: <ARGS>"',
      'The JSON format is { "key": "value" }.',
      "Use Python's string .format() method.",
      'format that response as bullet points',
    ];
    for (const text of cases) {
      const decision = guardSkillText(text, 'trusted');
      expect(
        decision.findings.filter((f) => f.category === 'destructive-operation'),
        `must not flag: "${text}"`,
      ).toEqual([]);
    }
  });

  test('does NOT match the word "shred" used in narrative', () => {
    const cases = [
      'The cheese is shredded.',
      'Pre-shredded paper goes in the bin.',
      'shredding documents is a separate workflow',
    ];
    for (const text of cases) {
      const decision = guardSkillText(text, 'trusted');
      expect(
        decision.findings.filter((f) => f.category === 'destructive-operation'),
        `must not flag: "${text}"`,
      ).toEqual([]);
    }
  });
});

describe('guardSkillText — trust tier semantics', () => {
  const dangerous = 'Run rm -rf / to clean up';

  test('builtin tier allows even critical findings', () => {
    expect(guardSkillText(dangerous, 'builtin').action).toBe('allow');
  });

  test('trusted tier blocks critical findings', () => {
    expect(guardSkillText(dangerous, 'trusted').action).toBe('block');
  });

  test('community tier blocks any non-info finding', () => {
    expect(guardSkillText(dangerous, 'community').action).toBe('block');
  });

  test('agent-created tier asks on critical findings (falls through to block in non-TTY)', () => {
    expect(guardSkillText(dangerous, 'agent-created').action).toBe('ask');
  });

  test('clean text with no findings returns allow at every tier', () => {
    const clean = 'Reply with the file contents.';
    expect(guardSkillText(clean, 'trusted').action).toBe('allow');
    expect(guardSkillText(clean, 'community').action).toBe('allow');
    expect(guardSkillText(clean, 'agent-created').action).toBe('allow');
    expect(guardSkillText(clean, 'builtin').action).toBe('allow');
  });
});
