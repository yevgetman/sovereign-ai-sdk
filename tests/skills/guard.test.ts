// Skill guard pattern coverage. The patterns blanket-block third-party
// skills that look dangerous; false positives silently disable legitimate
// skills, so each pattern needs both happy-path AND no-trigger coverage.

import { describe, expect, test } from 'bun:test';
import { guardSkillText } from '../../src/skills/guard.js';

describe('guardSkillText — destructive-operation patterns', () => {
  // The trust tier matters: cwd/.harness/skills/ is not 'trusted' or
  // 'community'; it's 'user' tier. Critical findings on user-tier skills
  // resolve to 'ask', which falls through to 'block' in non-interactive
  // contexts (semantic tests, piped stdin). So even a single critical
  // hit silently disables the skill.

  test('matches `rm -rf /` (intended catch)', () => {
    const decision = guardSkillText('Run rm -rf / to clean up.', 'user');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('matches `dd if=/dev/...` (intended catch)', () => {
    const decision = guardSkillText('Use dd if=/dev/zero of=/dev/sda', 'user');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('matches `shred ` as a command with arguments (intended catch)', () => {
    const decision = guardSkillText('Run shred -u sensitive.txt', 'user');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('does NOT match the noun "shredded" or shred used as a fragment', () => {
    // The previous \bshred\b matched "shred" anywhere (e.g. in narrative
    // text "the document was shredded"). Tightened to \bshred\s+ which
    // requires it to be a command verb followed by arguments.
    const decision = guardSkillText('The document was shredded.', 'user');
    expect(decision.findings.filter((f) => f.category === 'destructive-operation')).toEqual([]);
  });

  test('matches `format C:` Windows-style disk format (intended catch)', () => {
    const decision = guardSkillText('Run format C: to wipe', 'user');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('matches `format /dev/sda` Unix-style (intended catch)', () => {
    const decision = guardSkillText('Run format /dev/sda1', 'user');
    expect(decision.findings.some((f) => f.category === 'destructive-operation')).toBe(true);
  });

  test('matches `mkfs.ext4 /dev/...` (intended catch)', () => {
    const decision = guardSkillText('Run mkfs.ext4 /dev/sdb1', 'user');
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
      const decision = guardSkillText(text, 'user');
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
      const decision = guardSkillText(text, 'user');
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

  test('user tier asks on critical findings (falls through to block in non-TTY)', () => {
    expect(guardSkillText(dangerous, 'user').action).toBe('ask');
  });

  test('clean text with no findings returns allow at every tier', () => {
    const clean = 'Reply with the file contents.';
    expect(guardSkillText(clean, 'user').action).toBe('allow');
    expect(guardSkillText(clean, 'community').action).toBe('allow');
    expect(guardSkillText(clean, 'trusted').action).toBe('allow');
    expect(guardSkillText(clean, 'builtin').action).toBe('allow');
  });
});
