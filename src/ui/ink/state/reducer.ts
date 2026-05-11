// Phase 16.0b — pure reducer for the Ink TUI. Every UiEvent maps to a
// new UiState; never mutate the previous state (except the streaming
// text accumulator on the assistant tail message, which is allowed for
// O(1) appends — see types.ts note).

import type { TranscriptMessage, UiEvent, UiState } from './types.js';

export const initialUiState: UiState = {
  transcript: [],
  status: 'idle',
  tasks: {},
  statusLine: { cwd: '', profile: 'default' },
};

export function reduce(state: UiState, event: UiEvent): UiState {
  switch (event.type) {
    case 'user_input_submitted': {
      const msg: TranscriptMessage = { role: 'user', text: event.text };
      return { ...state, transcript: [...state.transcript, msg] };
    }
    case 'assistant_text_delta': {
      const last = state.transcript.at(-1);
      if (last?.role === 'assistant') {
        // Streaming append — mutate the text accumulator (see types.ts note),
        // but return a new array reference so React re-renders.
        const updated: TranscriptMessage = { ...last, text: last.text + event.delta };
        return { ...state, transcript: [...state.transcript.slice(0, -1), updated] };
      }
      const fresh: TranscriptMessage = { role: 'assistant', text: event.delta, streaming: true };
      return { ...state, transcript: [...state.transcript, fresh] };
    }
    case 'assistant_message_complete': {
      const last = state.transcript.at(-1);
      if (last?.role !== 'assistant') return state;
      const finalized: TranscriptMessage = { role: 'assistant', text: last.text };
      return { ...state, transcript: [...state.transcript.slice(0, -1), finalized] };
    }
    case 'tool_use': {
      const msg: TranscriptMessage = {
        role: 'tool_use',
        toolName: event.toolName,
        input: event.input,
      };
      return { ...state, transcript: [...state.transcript, msg] };
    }
    case 'tool_result': {
      const msg: TranscriptMessage = {
        role: 'tool_result',
        toolUseId: event.toolUseId,
        content: event.content,
      };
      return { ...state, transcript: [...state.transcript, msg] };
    }
    case 'agent_turn_start':
      return { ...state, status: 'thinking' };
    case 'agent_turn_end':
      return { ...state, status: 'idle' };
    case 'task_update':
      return {
        ...state,
        tasks: { ...state.tasks, [event.taskId]: { taskId: event.taskId, state: event.state } },
      };
    case 'status_line_update':
      return { ...state, statusLine: { ...state.statusLine, ...event.patch } };
    case 'system_message':
      return {
        ...state,
        transcript: [...state.transcript, { role: 'system', text: event.text }],
      };
  }
}
