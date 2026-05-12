// Phase 16.0b — Transcript renderer. One <Box> per message, color-coded by
// role. Tool input is JSON-stringified for now; rich rendering deferred
// to Phase 16.7.

import { Box, Text } from 'ink';
import type { TranscriptMessage } from './state/types.js';

type TranscriptProps = {
  readonly messages: ReadonlyArray<TranscriptMessage>;
};

export function Transcript({ messages }: TranscriptProps): JSX.Element {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: transcript is append-only; messages never reorder.
        <MessageRow key={i} msg={msg} />
      ))}
    </Box>
  );
}

function MessageRow({ msg }: { readonly msg: TranscriptMessage }): JSX.Element {
  switch (msg.role) {
    case 'user':
      return (
        <Box>
          <Text color="cyan">{'> '}</Text>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'system':
      return (
        <Box>
          <Text dimColor italic>
            {msg.text}
          </Text>
        </Box>
      );
    case 'command_output':
      return (
        <Box>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'tool_use':
      return (
        <Box>
          <Text color="yellow">⚙ {msg.toolName}</Text>
          <Text dimColor> {summarizeToolInput(msg.input)}</Text>
        </Box>
      );
    case 'tool_result':
      return (
        <Box>
          <Text color="green">↪ </Text>
          <Text dimColor>{truncate(msg.content, 200)}</Text>
        </Box>
      );
  }
}

function summarizeToolInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return truncate(s, 100);
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
