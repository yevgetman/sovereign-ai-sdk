// The collector's record shapes. These are the WIRE contract the
// `@yevgetman/sov-debug-console` element renders, so the two must stay in step;
// the element's copy is structural (it has no dependency on this package, by
// design — a browser bundle has no business in a Node SDK's graph).
//
// Where Appleo's original used closed unions for its own vocabulary
// (`surface: 'chat' | 'onboarding' | …`, `category: 'nav' | 'data' | …`), the
// SDK uses `string`. Those enumerations were one host's, and freezing them here
// would make every other host's surfaces unrepresentable.

/** One dispatched agent turn, recorded AT THE DISPATCH SEAM. */
export interface AgentDebugEvent {
  at: string;
  /** THE reference id — the session key a host can hand to an operator. */
  sessionId: string;
  /** The host's own word for where this turn came from. */
  surface: string;
  /** The lane that governed the model choice, when the host routes by lane. */
  lane?: string;
  model: string;
  workflow: string | null;
  /** First chars of the human's message, for matching turn to intent. */
  preview: string;
  /** Monotonic per collector — a stable sort key when timestamps collide. */
  seq: number;
}

export interface RecordInput {
  principal: string;
  sessionId: string;
  surface: string;
  lane?: string;
  model: string;
  workflow?: string | null;
  text?: string;
}

/**
 * Under-the-hood facts about a turn: which tools ran with what inputs, how much
 * reasoning, what the turn cost. The agent's prose is deliberately ABSENT — a
 * viewer sees that in the chat; this feed is the machinery.
 */
export type TurnDetailEvent =
  | {
      at: string;
      sessionId: string;
      kind: 'tool_call';
      tool: string;
      /** One line of the tool's INPUT — the command, the path, the pattern. */
      input?: string;
      /** The gateway's per-event seq — orders details within a session. */
      eventSeq: number;
      seq: number;
    }
  | {
      at: string;
      sessionId: string;
      kind: 'thinking';
      chars: number;
      /** The block's opening text — WHAT it was reasoning about. */
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
      /** Distinct tool names this turn, in first-use order. */
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

/** Omit that DISTRIBUTES over a union — plain Omit collapses the discriminants. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A turn detail as submitted; the collector stamps `at` and `seq`. */
export type TurnDetailInput = DistributiveOmit<TurnDetailEvent, 'at' | 'seq'>;

/**
 * One app-usage fact. `category` is the HOST's vocabulary — the console colours
 * by it without knowing what any particular value means.
 */
export interface TelemetryEvent {
  at: string;
  category: string;
  name: string;
  detail: string;
  status?: number;
  durationMs?: number;
  seq: number;
}

export interface TelemetryInput {
  principal: string;
  category: string;
  name: string;
  detail?: string;
  status?: number;
  durationMs?: number;
}

/** A host-supplied data change (the Data tab). The SDK never authors these. */
export interface DataEvent {
  at: string;
  ref?: string;
  summary: string;
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

/** What the console's REST adapter expects from the feed route. */
export interface AgentFeed {
  currentSessionId: string | null;
  events: AgentDebugEvent[];
  details: TurnDetailEvent[];
}
