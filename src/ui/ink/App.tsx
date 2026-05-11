// Phase 16.0b — Ink TUI root. Mounts <Transcript>, <Prompt>, and
// <StatusLine> against a single UiState dispatch loop. The dispatch is
// fed by:
//   - user input from <Prompt>
//   - stream events from query() (driven by useAgentTurn in Task 8)
//   - bus events from the DaemonEventBus (subscribed in Task 8)

import { Box, Text } from 'ink';
import { useReducer } from 'react';
import { initialUiState, reduce } from './state/reducer.js';

type AppProps = {
  readonly cwd: string;
  readonly profile: string;
};

export function App({ cwd, profile }: AppProps): JSX.Element {
  const [state] = useReducer(reduce, {
    ...initialUiState,
    statusLine: { cwd, profile },
  });
  return (
    <Box flexDirection="column">
      <Box flexGrow={1}>
        <Text dimColor>Phase 16.0b TUI scaffold — transcript will mount here.</Text>
      </Box>
      <Box>
        <Text dimColor>
          {state.statusLine.profile} · {state.statusLine.cwd}
        </Text>
      </Box>
    </Box>
  );
}
