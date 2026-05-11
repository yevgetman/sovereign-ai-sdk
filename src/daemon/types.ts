// Daemon event types — the union of all events the daemon bus can carry.
// The TUI (Phase 16.0b) subscribes to these to update its display.

export type DaemonEvent =
  | { type: 'daemon_started'; pid: number; profile: string; harnessHome: string }
  | { type: 'daemon_stopping'; reason: 'sigterm' | 'sigint' | 'error' | 'explicit' }
  | { type: 'task_update'; taskId: string; state: string }
  | { type: 'approval_requested'; requestId: string; tool: string; input: unknown }
  | { type: 'approval_resolved'; requestId: string; approved: boolean }
  | { type: 'session_cached'; sessionKey: string; sessionId: string }
  | { type: 'session_evicted'; sessionKey: string; sessionId: string };

export type DaemonEventType = DaemonEvent['type'];

/** Maps each event `type` literal to the full event shape. */
export type DaemonEventMap = {
  [E in DaemonEvent as E['type']]: E;
};
