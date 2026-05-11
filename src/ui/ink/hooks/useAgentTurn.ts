// Phase 16.0b — drives one user turn against the harness agent loop.
// Iterates the agent stream and translates StreamEvents + Messages
// into UiEvents for the Ink TUI reducer. Status transitions to
// 'thinking' on turn start and back to 'idle' on turn end.
//
// The hook accepts a runner abstraction — `(text: string) =>
// AsyncGenerator<StreamEvent | Message, Terminal>` — that matches
// both the bare `query()` generator and `AgentRunner.run()`. The
// caller (startInkTUI) constructs the runner once with the bundle,
// provider, tool pool, system prompt, etc., then passes it as a
// stable reference; this hook only consumes the generator.
//
// Event mapping (verified against terminalRepl.ts:1425-1626 and
// agentRunner.ts:142-167):
//   - StreamEvent `text_delta`         -> UiEvent `assistant_text_delta`
//   - StreamEvent `message_stop`       -> UiEvent `assistant_message_complete`
//   - StreamEvent `assistant_message`  -> emits a UiEvent `tool_use`
//                                          per `tool_use` ContentBlock
//                                          inside `message.content`.
//   - User Message (tool_result carrier yielded between turns)
//     -> emits a UiEvent `tool_result` per `tool_result` ContentBlock.
//
// Other StreamEvents (`message_start`, `thinking_delta`, `tool_use_delta`,
// `usage_delta`, `microcompact`, `loop_detected`, `route_decision`) are
// not surfaced in Phase 16.0b. They'll be wired into a richer status
// surface in Phase 16.7.

import { useCallback } from 'react';
import type { Message, StreamEvent, Terminal } from '../../../core/types.js';
import type { UiEvent } from '../state/types.js';

export type AgentTurnRunner = (prompt: string) => AsyncGenerator<StreamEvent | Message, Terminal>;

export type AgentTurnSubmit = (text: string) => Promise<void>;

export function useAgentTurn(
  runner: AgentTurnRunner,
  dispatch: (event: UiEvent) => void,
): { readonly submit: AgentTurnSubmit } {
  const submit = useCallback<AgentTurnSubmit>(
    async (text: string): Promise<void> => {
      dispatch({ type: 'user_input_submitted', text });
      dispatch({ type: 'agent_turn_start' });
      try {
        const gen = runner(text);
        for (;;) {
          const step = await gen.next();
          if (step.done) break;
          const ev = step.value;
          if (!ev || typeof ev !== 'object') continue;

          // User Message branch — tool_result carrier yielded between turns.
          if ('role' in ev) {
            if (ev.role === 'user') {
              for (const block of ev.content) {
                if (block.type !== 'tool_result') continue;
                dispatch({
                  type: 'tool_result',
                  toolUseId: block.tool_use_id,
                  content: block.content,
                });
              }
            }
            continue;
          }

          // StreamEvent branch.
          if (!('type' in ev)) continue;
          if (ev.type === 'text_delta') {
            dispatch({ type: 'assistant_text_delta', delta: ev.text });
            continue;
          }
          if (ev.type === 'message_stop') {
            dispatch({ type: 'assistant_message_complete' });
            continue;
          }
          if (ev.type === 'assistant_message') {
            for (const block of ev.message.content) {
              if (block.type === 'tool_use') {
                dispatch({ type: 'tool_use', toolName: block.name, input: block.input });
              }
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'system_message', text: `error: ${msg}` });
      } finally {
        dispatch({ type: 'agent_turn_end' });
      }
    },
    [runner, dispatch],
  );
  return { submit };
}
