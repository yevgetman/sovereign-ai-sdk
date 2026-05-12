// Phase 16.0b — Ink TUI root. Mounts <Transcript>, <Prompt>, and
// <StatusLine> against a single UiState dispatch loop. The dispatch is
// fed by:
//   - user input from <Prompt> (driven by useAgentTurn)
//   - stream events from query() (driven by useAgentTurn)
//   - bus events from the DaemonEventBus (driven by useBusSubscription)

import { Box } from 'ink';
import type { JSX } from 'react';
import { useReducer } from 'react';
import type { DaemonEventBus } from '../../daemon/eventBus.js';
import { Prompt } from './Prompt.js';
import { StatusLine } from './StatusLine.js';
import { Transcript } from './Transcript.js';
import type { AgentTurnRunner } from './hooks/useAgentTurn.js';
import { useAgentTurn } from './hooks/useAgentTurn.js';
import { useBusSubscription } from './hooks/useBusSubscription.js';
import { initialUiState, reduce } from './state/reducer.js';
import type { UiState } from './state/types.js';

type AppProps = {
  readonly runner: AgentTurnRunner;
  readonly bus: DaemonEventBus;
  readonly cwd: string;
  readonly profile: string;
  readonly provider?: string;
  readonly model?: string;
  /** Clean-exit callback. The host (startInkTUI) supplies one that emits
   *  `daemon_stopping`, then unmounts on the next tick so the React tree
   *  can flush the resulting `system_message` dispatch. Plain
   *  `process.exit(0)` skips this — and the memory-flush + lock-release
   *  in startInkTUI's finally block — so always wire this through. */
  readonly onExit: () => void;
};

export function App({ runner, bus, cwd, profile, provider, model, onExit }: AppProps): JSX.Element {
  // `exactOptionalPropertyTypes` rejects `provider: undefined` literal
  // assignment; conditionally spread only the defined slots so undefined
  // keys are omitted entirely rather than set to `undefined`.
  const statusLine: UiState['statusLine'] = {
    cwd,
    profile,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  };
  const [state, dispatch] = useReducer(reduce, { ...initialUiState, statusLine });
  useBusSubscription(bus, dispatch);
  const { submit } = useAgentTurn(runner, dispatch);

  return (
    <Box flexDirection="column">
      <Box flexGrow={1} flexDirection="column">
        <Transcript messages={state.transcript} />
      </Box>
      <Prompt
        onSubmit={(text): void => {
          void submit(text);
        }}
        onAbort={onExit}
        disabled={state.status !== 'idle'}
      />
      <StatusLine statusLine={state.statusLine} status={state.status} />
    </Box>
  );
}
