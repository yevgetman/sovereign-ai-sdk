// Phase 16.0c Wave 1 — routes slash-prefixed input through the registry.
// Sits parallel to useAgentTurn; App.tsx's onSubmit chooses based on
// the leading '/' character.

import { useCallback } from 'react';
import { dispatchSlashCommand } from '../../../commands/registry.js';
import type { CommandContext } from '../../../commands/types.js';
import type { UiEvent } from '../state/types.js';

export type SlashDispatch = (text: string) => Promise<void>;

export function useSlashDispatch(
  ctx: CommandContext,
  dispatch: (event: UiEvent) => void,
): { readonly dispatch: SlashDispatch } {
  const dispatchSlash = useCallback<SlashDispatch>(
    async (text: string): Promise<void> => {
      dispatch({ type: 'user_input_submitted', text });
      try {
        const result = await dispatchSlashCommand(text, ctx);
        if (result.output) {
          if (result.kind === 'unknown') {
            dispatch({ type: 'system_message', text: result.output });
          } else {
            dispatch({ type: 'command_output', text: result.output });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'system_message', text: `error: ${msg}` });
      }
    },
    [ctx, dispatch],
  );
  return { dispatch: dispatchSlash };
}
