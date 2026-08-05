// The debug console's contract (spec §2/§3).
//
// THE SPLIT THIS FILE ENCODES: the Agent surface is the SDK's own — every host
// running the SDK has an agent stream, so its shape is fixed here. Telemetry
// and Data are the HOST's vocabulary: "what is a request" and "what is a data
// change" differ per application, so those are open shapes the host fills.
// Hard-coding one host's answers (Appleo's HTTP requests and git commits) would
// make this console that host's, not the SDK's.

/** One dispatched agent turn, recorded where the model decision is made. */
export interface AgentDebugEvent {
  at: string;
  /** THE reference id — whatever the host uses to key a durable transcript. */
  sessionId: string;
  /** Free-form: the SDK does not enumerate a host's surfaces. */
  surface: string;
  /** The routing lane, when the host has lanes. */
  lane?: string;
  model: string;
  workflow?: string | null;
  /** A short excerpt of the human message, for orientation. */
  preview?: string;
  /** Monotonic within a collector — the merge key for the interleaved feed. */
  seq: number;
}

/** Under-the-hood facts: what the agent actually did between messages. */
export type TurnDetailEvent =
  | {
      at: string;
      sessionId: string;
      kind: 'tool_call';
      tool: string;
      /** One line of the tool's INPUT — "Bash" alone tells nobody anything. */
      input?: string;
      eventSeq: number;
      seq: number;
    }
  | {
      at: string;
      sessionId: string;
      kind: 'thinking';
      chars: number;
      /** The block's opening text — what it was reasoning ABOUT. */
      preview: string;
      eventSeq: number;
      seq: number;
    }
  | {
      at: string;
      sessionId: string;
      kind: 'turn_end';
      finishReason: string;
      toolCalls: number;
      tools: string[];
      thinkingChars: number;
      textChars: number;
      tokensIn?: number;
      tokensOut?: number;
      cost?: number;
      eventSeq: number;
      seq: number;
    }
  | {
      at: string;
      sessionId: string;
      kind: 'turn_error';
      error: string;
      eventSeq: number;
      seq: number;
    };

export interface AgentFeed {
  /** The live session id, when one exists. */
  currentSessionId: string | null;
  events: AgentDebugEvent[];
  details: TurnDetailEvent[];
}

/**
 * A host-supplied telemetry row. `category` is the host's own word — the
 * console colours by it without knowing what any particular value means.
 */
export interface TelemetryEvent {
  at: string;
  category: string;
  name: string;
  detail?: string;
  /** Rendered as a status when present; >=400 reads as a failure. */
  status?: number;
  durationMs?: number;
  seq: number;
}

/**
 * A host-supplied data change. Deliberately minimal and NOT modelled on any one
 * host's storage: a commit, a row write, and a file edit all fit.
 */
export interface DataEvent {
  at: string;
  /** A short stable handle — a sha, an id, a path. */
  ref?: string;
  /** What changed, in the host's words. */
  summary: string;
  /** Optional tags rendered as chips — a branch, a table, a collection. */
  labels?: string[];
  /**
   * An optional heading rows are grouped under. A host whose data changes
   * arrive through more than one mechanism (say, commits AND HTTP writes) can
   * keep them visually distinct without the console knowing what either is.
   * Rows are rendered in the order given; a heading is emitted when it changes.
   */
  group?: string;
  seq: number;
}

/**
 * The data seam. Every method beyond `getAgentFeed` is CAPABILITY-GATED:
 * absence hides the tab entirely. A host with no telemetry gets a two-tab
 * console, never an empty tab implying there is nothing to see.
 *
 * The probe is `typeof adapter[method] === 'function'` and it NEVER invokes.
 */
export interface DebugConsoleAdapter {
  getAgentFeed(): Promise<AgentFeed>;
  getTelemetry?(): Promise<TelemetryEvent[]>;
  getData?(): Promise<DataEvent[]>;
  /** Report a client-side event (a navigation). Fire-and-forget. */
  reportEvent?(event: { name: string; detail?: string }): void;
}

export type TabId = 'agent' | 'telemetry' | 'data';

/** Every noun the console renders, so wording is configuration, not markup. */
export interface DebugConsoleLabels {
  brand: string;
  agent: string;
  telemetry: string;
  data: string;
  emptyAgent: string;
  emptyTelemetry: string;
  emptyData: string;
  footer: string;
}

export const DEFAULT_LABELS: DebugConsoleLabels = {
  brand: 'Agent debug',
  agent: 'Agent',
  telemetry: 'Telemetry',
  data: 'Data',
  emptyAgent: 'No agent turns recorded yet. Run something.',
  emptyTelemetry: 'No telemetry yet.',
  emptyData: 'No data changes yet.',
  footer: 'Rings are per process; a restart empties them.',
};
