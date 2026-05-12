// Phase 16.0b/c — Ink TUI root. Mounts <Transcript>, <Prompt>, and
// <StatusLine> against a single UiState dispatch loop. Inputs arrive
// either as agent prompts (useAgentTurn) or as slash commands
// (useSlashDispatch); the /-prefix decides the path.

import { Box } from 'ink';
import type { JSX } from 'react';
import { useEffect, useReducer } from 'react';
import type { CommandContext } from '../../commands/types.js';
import type { DaemonEventBus } from '../../daemon/eventBus.js';
import { Prompt } from './Prompt.js';
import { StatusLine } from './StatusLine.js';
import { Transcript } from './Transcript.js';
import type { AgentTurnRunner } from './hooks/useAgentTurn.js';
import { useAgentTurn } from './hooks/useAgentTurn.js';
import { useBusSubscription } from './hooks/useBusSubscription.js';
import { useSlashDispatch } from './hooks/useSlashDispatch.js';
import { initialUiState, reduce } from './state/reducer.js';
import type { UiEvent, UiState } from './state/types.js';

type AppProps = {
  readonly runner: AgentTurnRunner;
  readonly bus: DaemonEventBus;
  readonly cwd: string;
  readonly profile: string;
  readonly provider: string;
  readonly model: string;
  readonly commandContext: CommandContext;
  /** Receives the latest UiState by reference; the host uses this in
   *  CommandContext.getCost so commands see post-streaming values. */
  readonly latestStateRef: { current: UiState };
  /** Host writes the reducer dispatch fn here on mount so out-of-React
   *  callbacks (CommandContext.clearHistory, setModel) can emit
   *  transcript_cleared and status_line_update events. */
  readonly uiDispatchRef: { current: ((e: UiEvent) => void) | null };
  readonly onExit: () => void;
};

export function App({
  runner,
  bus,
  cwd,
  profile,
  provider,
  model,
  commandContext,
  latestStateRef,
  uiDispatchRef,
  onExit,
}: AppProps): JSX.Element {
  const statusLine: UiState['statusLine'] = { cwd, profile, provider, model };
  const [state, dispatch] = useReducer(reduce, { ...initialUiState, statusLine });
  // Keep the host's refs in sync so out-of-React getters/setters
  // (CommandContext.getCost / clearHistory / setModel) interact with the
  // latest reducer state and can emit dispatch events.
  useEffect(() => {
    latestStateRef.current = state;
  }, [state, latestStateRef]);
  useEffect(() => {
    uiDispatchRef.current = dispatch;
    return () => {
      uiDispatchRef.current = null;
    };
  }, [uiDispatchRef]);
  useBusSubscription(bus, dispatch);
  const { submit } = useAgentTurn(runner, dispatch, { providerName: provider, model });
  const { dispatch: dispatchSlash } = useSlashDispatch(commandContext, dispatch);

  return (
    <Box flexDirection="column">
      <Box flexGrow={1} flexDirection="column">
        <Transcript messages={state.transcript} />
      </Box>
      <Prompt
        onSubmit={(text): void => {
          if (text.startsWith('/')) {
            void dispatchSlash(text);
          } else {
            void submit(text);
          }
        }}
        onAbort={onExit}
        disabled={state.status !== 'idle'}
      />
      <StatusLine statusLine={state.statusLine} status={state.status} />
    </Box>
  );
}
