// Phase 16.0b — minimal prompt input. Accumulates characters into a
// buffer; Enter submits + clears; Ctrl-C signals abort; Backspace
// deletes the previous character. No autocomplete (Phase 16.7).
//
// When `disabled` is true (agent mid-turn), Enter is suppressed so a
// second concurrent query() generator cannot be launched. Typing into
// the buffer, Backspace, and Ctrl-C continue to work — only the submit
// action is gated. The marker is dimmed as a visual cue.

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

type PromptProps = {
  readonly onSubmit: (text: string) => void;
  readonly onAbort: () => void;
  readonly disabled?: boolean;
};

export function Prompt({ onSubmit, onAbort, disabled = false }: PromptProps): JSX.Element {
  const [value, setValue] = useState('');
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onAbort();
      return;
    }
    if (key.return) {
      if (disabled) return;
      const trimmed = value.trim();
      if (trimmed.length > 0) onSubmit(trimmed);
      setValue('');
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.meta && !key.ctrl) {
      setValue((v) => v + input);
    }
  });
  return (
    <Box>
      <Text color="cyan" dimColor={disabled}>
        {disabled ? '⋯ ' : '❯ '}
      </Text>
      <Text>{value}</Text>
    </Box>
  );
}
