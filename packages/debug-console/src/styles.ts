// The shadow-root stylesheet.
//
// Every colour, font and radius is read from a `--sdc-*` custom property.
// Custom properties inherit THROUGH the shadow boundary, and a host's own rule
// for the element outranks these `:host` defaults — so theming is CSS, with no
// fork and no build step. (Same contract assay's dashboard exposes; it is the
// reason Appleo could restyle that element without touching its source.)

export const CONSOLE_CSS = `
:host {
  --sdc-bg: #0d1117;
  --sdc-surface: #161b22;
  --sdc-line: #30363d;
  --sdc-ink: #e6edf3;
  --sdc-ink-soft: #8b949e;
  --sdc-accent: #3fb950;
  --sdc-link: #79c0ff;
  --sdc-warn: #ffa657;
  --sdc-bad: #f85149;
  --sdc-tool: #d2a8ff;
  --sdc-font: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --sdc-radius: 10px;
  --sdc-z: 9999;
  display: contents;
}

* { box-sizing: border-box; }

.pill {
  position: fixed;
  right: 12px;
  bottom: 140px;
  z-index: var(--sdc-z);
  background: var(--sdc-bg);
  color: var(--sdc-accent);
  border: 1px solid var(--sdc-line);
  border-radius: 999px;
  font: 600 11px/1 var(--sdc-font);
  letter-spacing: 0.08em;
  padding: 8px 14px;
  cursor: pointer;
  opacity: 0.85;
  touch-action: none;
}
.pill:hover { opacity: 1; }

.panel {
  position: fixed;
  right: 16px;
  bottom: 96px;
  z-index: var(--sdc-z);
  width: min(560px, calc(100vw - 32px));
  height: min(480px, 70vh);
  min-width: 380px;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  resize: both;
  overflow: hidden;
  background: var(--sdc-bg);
  color: var(--sdc-ink);
  border: 1px solid var(--sdc-line);
  border-radius: var(--sdc-radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  font: 12px/1.5 var(--sdc-font);
}
.panel--page {
  position: static;
  width: 100%;
  height: calc(100vh - 32px);
  resize: none;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sdc-line);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.header:active { cursor: grabbing; }
.title { font-weight: 600; color: var(--sdc-accent); letter-spacing: 0.06em; }
.actions { display: flex; align-items: center; gap: 8px; }

.btn {
  background: #21262d;
  border: 1px solid var(--sdc-line);
  color: var(--sdc-ink-soft);
  border-radius: 5px;
  font: inherit;
  font-size: 10.5px;
  padding: 1px 7px;
  cursor: pointer;
  flex-shrink: 0;
}
.btn:hover { color: var(--sdc-ink); border-color: var(--sdc-ink-soft); }
.close {
  background: none; border: 0; color: var(--sdc-ink-soft);
  font-size: 16px; cursor: pointer; padding: 0 4px;
}
.close:hover { color: var(--sdc-ink); }

.session {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sdc-line);
  background: var(--sdc-surface);
}
.session-label {
  color: var(--sdc-ink-soft); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: 0.08em;
}
.session-id { color: var(--sdc-link); overflow-wrap: anywhere; }
.muted { color: var(--sdc-ink-soft); }

.tabs { display: flex; gap: 2px; padding: 6px 10px 0; border-bottom: 1px solid var(--sdc-line); }
.tab {
  background: none; border: 0; border-bottom: 2px solid transparent;
  color: var(--sdc-ink-soft); font: inherit; font-size: 11.5px;
  letter-spacing: 0.04em; padding: 4px 10px 6px; cursor: pointer;
}
.tab:hover { color: var(--sdc-ink); }
.tab--active { color: var(--sdc-accent); border-bottom-color: var(--sdc-accent); }

.feed { overflow-y: auto; padding: 4px 0; flex: 1; }

.divider {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px 2px;
  color: var(--sdc-link); font-size: 11px;
  border-top: 1px dashed var(--sdc-line);
}
.divider:first-child { border-top: 0; }
.divider code { overflow-wrap: anywhere; }

.row { display: flex; align-items: baseline; gap: 8px; padding: 3px 12px; flex-wrap: wrap; }
.row:hover { background: var(--sdc-surface); }
.time { color: var(--sdc-ink-soft); flex-shrink: 0; }
.tag {
  border: 1px solid var(--sdc-line); border-radius: 4px;
  padding: 0 5px; font-size: 10.5px; flex-shrink: 0;
}
.lane { color: var(--sdc-ink); }
.lane strong { color: var(--sdc-accent); font-weight: 600; }
.lane em { color: var(--sdc-tool); font-style: normal; }
.preview { color: var(--sdc-ink-soft); flex-basis: 100%; padding-left: 66px; overflow-wrap: anywhere; }

.detail { display: flex; gap: 8px; padding: 1px 12px 1px 28px; color: var(--sdc-ink-soft); font-size: 11.5px; }
.detail .time { flex-shrink: 0; }
.tool { color: var(--sdc-tool); }
.tool-input { color: var(--sdc-ink-soft); }
.thinking-preview { color: #6e7681; font-style: italic; overflow-wrap: anywhere; }
.detail--error { color: var(--sdc-bad); }
.detail--end em { color: var(--sdc-link); font-style: normal; }

.status { color: var(--sdc-ink-soft); flex-shrink: 0; }
.status--bad { color: var(--sdc-bad); }
.ms { color: var(--sdc-ink-soft); flex-shrink: 0; }
.ms--slow { color: var(--sdc-warn); }
.ref { color: var(--sdc-link); flex-shrink: 0; }
.label-chip { color: var(--sdc-warn); flex-shrink: 0; }

.group {
  padding: 8px 12px 2px;
  color: var(--sdc-ink-soft);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-top: 1px solid var(--sdc-line);
}
.group:first-child { border-top: 0; }

.empty { color: var(--sdc-ink-soft); padding: 16px 12px; text-align: center; }
.footer {
  padding: 6px 12px; border-top: 1px solid var(--sdc-line);
  color: var(--sdc-ink-soft); font-size: 10.5px;
}
`;
