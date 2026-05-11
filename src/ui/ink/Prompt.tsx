// Phase 16.0b — minimal prompt input. Accumulates characters into a
// buffer; Enter submits + clears; Ctrl-C signals abort; Backspace
// deletes the previous character. No autocomplete (Phase 16.7).

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

type PromptProps = {
  readonly onSubmit: (text: string) => void;
  readonly onAbort: () => void;
};

export function Prompt({ onSubmit, onAbort }: PromptProps): JSX.Element {
  const [value, setValue] = useState('');
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onAbort();
      return;
    }
    if (key.return) {
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
      <Text color="cyan">{'❯ '}</Text>
      <Text>{value}</Text>
    </Box>
  );
}
