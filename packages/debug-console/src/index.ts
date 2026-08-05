export {
  DEFAULT_TAG,
  ERROR_EVENT,
  RENDER_EVENT,
  SovDebugConsoleElement,
} from './element.js';
export { defineDebugConsole } from './register.js';
export { createRestAdapter, type RestAdapterOptions } from './restAdapter.js';
export {
  DEFAULT_LABELS,
  type AgentDebugEvent,
  type AgentFeed,
  type DataEvent,
  type DebugConsoleAdapter,
  type DebugConsoleLabels,
  type TabId,
  type TelemetryEvent,
  type TurnDetailEvent,
} from './types.js';

// NOTE: this entry does NOT register the element. An ESM consumer picks its own
// tag and calls `defineDebugConsole()`; a bare import must never mutate the
// global custom-element registry. The `./iife` build (src/iife-entry.ts) does
// register, because a host dropping in one <script> tag expects exactly that.
