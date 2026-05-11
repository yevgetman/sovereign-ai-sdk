// Phase 16.0b — Ink TUI root. Mounts <Transcript>, <Prompt>, and
// <StatusLine> against a single UiState dispatch loop. The dispatch is
// fed by:
//   - user input from <Prompt>
//   - stream events from query() (driven by useAgentTurn in Task 8)
//   - bus events from the DaemonEventBus (subscribed in Task 8)

import { Box } from 'ink';
import { useReducer } from 'react';
import { Prompt } from './Prompt.js';
import { StatusLine } from './StatusLine.js';
import { Transcript } from './Transcript.js';
import { initialUiState, reduce } from './state/reducer.js';

type AppProps = {
  readonly cwd: string;
  readonly profile: string;
};

export function App({ cwd, profile }: AppProps): JSX.Element {
  const [state, dispatch] = useReducer(reduce, {
    ...initialUiState,
    statusLine: { cwd, profile },
  });
  return (
    <Box flexDirection="column">
      <Box flexGrow={1}>
        <Transcript messages={state.transcript} />
      </Box>
      <Prompt
        onSubmit={(text) => dispatch({ type: 'user_input_submitted', text })}
        onAbort={() => process.exit(0)}
      />
      <StatusLine statusLine={state.statusLine} status={state.status} />
    </Box>
  );
}
