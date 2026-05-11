// Phase 16.0b — Ink TUI state shape and event vocabulary.

export type UiStatus = 'idle' | 'thinking' | 'tool';

export type TranscriptMessage =
  | { readonly role: 'user'; readonly text: string }
  // Assistant streaming: `text` is `readonly` like the other variants.
  // The reducer rebuilds the tail message via spread on every delta, so
  // the accumulated text always lives in a fresh object — no mutation
  // required. The transcript array gets a new reference per delta, so
  // React re-renders. See reducer.ts.
  | { readonly role: 'assistant'; readonly text: string; readonly streaming?: boolean }
  | { readonly role: 'system'; readonly text: string }
  | { readonly role: 'tool_use'; readonly toolName: string; readonly input: unknown }
  | { readonly role: 'tool_result'; readonly toolUseId: string; readonly content: string };

export type TaskCardState = {
  readonly taskId: string;
  readonly state: string;
};

export type UiState = {
  readonly transcript: ReadonlyArray<TranscriptMessage>;
  readonly status: UiStatus;
  readonly tasks: Readonly<Record<string, TaskCardState>>;
  readonly statusLine: Readonly<{
    cwd: string;
    profile: string;
    provider?: string;
    model?: string;
    sessionCostUsd?: number;
  }>;
};

export type UiEvent =
  | { type: 'user_input_submitted'; text: string }
  | { type: 'assistant_text_delta'; delta: string }
  | { type: 'assistant_message_complete' }
  | { type: 'tool_use'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string }
  | { type: 'agent_turn_start' }
  | { type: 'agent_turn_end' }
  | { type: 'task_update'; taskId: string; state: string }
  | { type: 'status_line_update'; patch: Partial<UiState['statusLine']> }
  | { type: 'system_message'; text: string };
