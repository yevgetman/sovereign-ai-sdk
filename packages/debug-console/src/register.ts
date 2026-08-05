// Registration. Idempotent because a host may load the bundle twice (an SPA
// route split, a hot reload) and `customElements.define` throws on a repeat —
// which would take down the host's page over a debug tool.

import { DEFAULT_TAG, SovDebugConsoleElement } from './element.js';

export function defineDebugConsole(tag: string = DEFAULT_TAG): typeof SovDebugConsoleElement {
  if (typeof customElements === 'undefined') return SovDebugConsoleElement;
  const existing = customElements.get(tag);
  if (existing !== undefined) return existing as typeof SovDebugConsoleElement;
  customElements.define(tag, SovDebugConsoleElement);
  return SovDebugConsoleElement;
}
