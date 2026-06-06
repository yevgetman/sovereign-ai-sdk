// Phase C T1 — the embedded web UI shell.
//
// The browser chat client (T2) is a single self-contained HTML file served
// at GET / and GET /ui. To make it ship inside the `bun build --compile`
// binary we embed it as a co-located text import. Bun inlines `with { type }`
// import attributes into the compiled binary (the same mechanism version.ts
// already relies on for `with { type: 'json' }`), so the HTML travels with the
// executable — no filesystem read at runtime, no side-car asset to discover.
//
// webui.html is the single source of truth; this module only re-exports it.

import webUiHtml from './webui.html' with { type: 'text' };

// bun-types stubs `.html` imports as its bundler `HTMLBundle` type keyed off the
// file extension, but `with { type: 'text' }` yields a plain string at runtime
// (verified: `typeof webUiHtml === 'string'`). Coerce through `unknown` so the
// public export is the real `string` shape callers use with `c.html(...)`.
/** The full HTML document for the web UI shell, embedded at build time. */
export const WEB_UI_HTML: string = webUiHtml as unknown as string;
