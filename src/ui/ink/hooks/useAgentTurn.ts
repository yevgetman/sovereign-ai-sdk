// Phase 16.0b/c — drives one user turn against the harness agent loop.
// Iterates the agent stream and translates StreamEvents + Messages
// into UiEvents for the Ink TUI reducer. Status transitions to
// 'thinking' on turn start and back to 'idle' on turn end.
//
// Wave 1 adds usage_delta forwarding so /cost can read accumulated
// session token totals + estimated USD from the reducer.

import { useCallback } from 'react';
import type { Message, StreamEvent, Terminal } from '../../../core/types.js';
import { estimateCostUsd } from '../../../providers/pricing.js';
import type { UiEvent } from '../state/types.js';

export type AgentTurnRunner = (prompt: string) => AsyncGenerator<StreamEvent | Message, Terminal>;

export type AgentTurnSubmit = (text: string) => Promise<void>;

export type AgentTurnOpts = {
  readonly providerName: string;
  readonly model: string;
};

export function useAgentTurn(
  runner: AgentTurnRunner,
  dispatch: (event: UiEvent) => void,
  opts: AgentTurnOpts,
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
            continue;
          }
          if (ev.type === 'usage_delta') {
            const usage = ev.usage;
            const estimatedUsdDelta = estimateCostUsd(opts.providerName, opts.model, usage);
            const delta: {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
            } = {};
            if (usage.inputTokens !== undefined) delta.inputTokens = usage.inputTokens;
            if (usage.outputTokens !== undefined) delta.outputTokens = usage.outputTokens;
            if (usage.cacheReadInputTokens !== undefined)
              delta.cacheReadTokens = usage.cacheReadInputTokens;
            if (usage.cacheCreationInputTokens !== undefined)
              delta.cacheWriteTokens = usage.cacheCreationInputTokens;
            dispatch({
              type: 'usage_delta',
              delta,
              estimatedUsdDelta,
            });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'system_message', text: `error: ${msg}` });
      } finally {
        dispatch({ type: 'agent_turn_end' });
      }
    },
    [runner, dispatch, opts.providerName, opts.model],
  );
  return { submit };
}
