// `@yevgetman/sov-sdk/debug` — the server half of the debug console.
//
// A SUBPATH, not part of the root barrel: this is an optional organ, and a host
// that never mounts a console should not carry it. Pair it with the browser
// element in `@yevgetman/sov-debug-console`, which is a separate package for
// the same reason in reverse — a browser bundle has no business in a Node SDK's
// dependency graph.

export {
  createDebugCollector,
  NULL_DEBUG_COLLECTOR,
  type DebugCollector,
  type DebugCollectorOptions,
} from './debug/collector.js';
export {
  createDebugRouteHandlers,
  type DebugRequestContext,
  type DebugRouteHandlers,
  type DebugRouteOptions,
  type DebugRouteResponse,
} from './debug/routes.js';
export {
  createTurnObserver,
  summariseToolInput,
  type ObservableEvent,
  type TurnObserver,
  type TurnObserverOptions,
} from './debug/turn-observer.js';
export type {
  AgentDebugEvent,
  AgentFeed,
  DataEvent,
  RecordInput,
  TelemetryEvent,
  TelemetryInput,
  TurnDetailEvent,
  TurnDetailInput,
} from './debug/types.js';
