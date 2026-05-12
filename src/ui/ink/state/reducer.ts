// Phase 16.0b/c — pure reducer for the Ink TUI. Every UiEvent maps to a
// new UiState; nothing is mutated. The streaming-delta case rebuilds the
// tail assistant message via spread so both the array and the message
// reference change, prompting React to re-render. See types.ts note.

import type { TranscriptMessage, UiEvent, UiState } from './types.js';
import { zeroCost } from './types.js';

export const initialUiState: UiState = {
  transcript: [],
  status: 'idle',
  tasks: {},
  sessionCost: zeroCost,
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
    case 'command_output':
      return {
        ...state,
        transcript: [...state.transcript, { role: 'command_output', text: event.text }],
      };
    case 'usage_delta': {
      const cur = state.sessionCost;
      return {
        ...state,
        sessionCost: {
          inputTokens: cur.inputTokens + (event.delta.inputTokens ?? 0),
          outputTokens: cur.outputTokens + (event.delta.outputTokens ?? 0),
          cacheReadTokens: cur.cacheReadTokens + (event.delta.cacheReadTokens ?? 0),
          cacheWriteTokens: cur.cacheWriteTokens + (event.delta.cacheWriteTokens ?? 0),
          estimatedUsd: cur.estimatedUsd + event.estimatedUsdDelta,
        },
      };
    }
    case 'transcript_cleared':
      return { ...state, transcript: [], sessionCost: zeroCost };
  }
}
