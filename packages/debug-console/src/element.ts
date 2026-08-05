// `<sov-debug-console>` — the mountable element (spec §1).
//
// ONE element, open shadow root, zero runtime dependencies. It NEVER fetches on
// its own paths: a host injects a `DebugConsoleAdapter` and the element renders
// whatever that adapter can answer.
//
// CAPABILITY GATING BY PROBE: `typeof adapter[m] === 'function'`, and the probe
// NEVER invokes. A tab whose method is absent does not exist here — a host with
// no telemetry sees a two-tab console, not an empty tab implying nothing
// happened.
//
// AUTHENTICATION IS NEVER THIS COMPONENT'S JOB. It has no login, no token, no
// credential, and no opinion about who may look. A host mounts it behind its
// own session, exactly as it would any other privileged view.

import { CONSOLE_CSS } from './styles.js';
import {
  type AgentDebugEvent,
  type AgentFeed,
  DEFAULT_LABELS,
  type DataEvent,
  type DebugConsoleAdapter,
  type DebugConsoleLabels,
  type TabId,
  type TelemetryEvent,
  type TurnDetailEvent,
} from './types.js';

export const DEFAULT_TAG = 'sov-debug-console';
export const RENDER_EVENT = 'sov-debug-render';
export const ERROR_EVENT = 'sov-debug-error';

const POLL_MS = 3000;
const DRAG_THRESHOLD_PX = 4;

interface Capabilities {
  telemetry: boolean;
  data: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;',
  );
}

function timeOf(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

export class SovDebugConsoleElement extends HTMLElement {
  #adapter: DebugConsoleAdapter | null = null;
  #labels: DebugConsoleLabels = DEFAULT_LABELS;
  #caps: Capabilities = { telemetry: false, data: false };
  #tab: TabId = 'agent';
  #open = false;
  #page = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #feed: AgentFeed = { currentSessionId: null, events: [], details: [] };
  #telemetry: TelemetryEvent[] = [];
  #data: DataEvent[] = [];
  #pos: { x: number; y: number } | null = null;
  #dragged = false;
  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  /** The data seam. Setting it re-probes capabilities and redraws. */
  set adapter(next: DebugConsoleAdapter | null) {
    this.#adapter = next;
    // THE PROBE: presence of a function, never a call. Calling to test would
    // make an empty-but-present surface indistinguishable from an absent one.
    this.#caps = {
      telemetry: typeof next?.getTelemetry === 'function',
      data: typeof next?.getData === 'function',
    };
    if (!this.#caps[this.#tab as 'telemetry' | 'data'] && this.#tab !== 'agent')
      this.#tab = 'agent';
    void this.refresh();
  }
  get adapter(): DebugConsoleAdapter | null {
    return this.#adapter;
  }

  set labels(next: Partial<DebugConsoleLabels>) {
    this.#labels = { ...DEFAULT_LABELS, ...next };
    this.#render();
  }

  /** Full-page mode: no drag, no resize, fills its container. */
  set page(next: boolean) {
    this.#page = next;
    this.#open = next ? true : this.#open;
    this.#render();
  }

  connectedCallback(): void {
    this.#open = this.#page || this.getAttribute('open') === 'true';
    this.#render();
    void this.refresh();
    this.#syncPolling();
  }

  disconnectedCallback(): void {
    this.#stopPolling();
  }

  /** Re-read every published surface and redraw. */
  async refresh(): Promise<void> {
    const adapter = this.#adapter;
    if (adapter === null) return;
    try {
      const [feed, telemetry, data] = await Promise.all([
        adapter.getAgentFeed(),
        this.#caps.telemetry && adapter.getTelemetry
          ? adapter.getTelemetry()
          : Promise.resolve(null),
        this.#caps.data && adapter.getData ? adapter.getData() : Promise.resolve(null),
      ]);
      this.#feed = feed;
      if (telemetry !== null) this.#telemetry = telemetry;
      if (data !== null) this.#data = data;
      this.#render();
      this.dispatchEvent(
        new CustomEvent(RENDER_EVENT, {
          detail: { tab: this.#tab },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (error: unknown) {
      // A read failure keeps the last good frame — tearing the console down
      // mid-incident is the opposite of useful — and says so out loud.
      this.dispatchEvent(
        new CustomEvent(ERROR_EVENT, {
          detail: { message: error instanceof Error ? error.message : 'read failed' },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  #syncPolling(): void {
    this.#stopPolling();
    // Only while OPEN: a closed console costs nothing.
    if (!this.#open) return;
    this.#timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  #stopPolling(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  #render(): void {
    const style = `<style>${CONSOLE_CSS}</style>`;
    if (!this.#open && !this.#page) {
      this.#root.innerHTML = `${style}<button class="pill" part="pill">DEBUG</button>`;
      this.#wirePill();
      return;
    }

    const positioned =
      this.#pos !== null && !this.#page
        ? ` style="left:${this.#pos.x}px;top:${this.#pos.y}px;right:auto;bottom:auto"`
        : '';

    this.#root.innerHTML = `${style}
<div class="panel${this.#page ? ' panel--page' : ''}" part="panel"${positioned}>
  <div class="header" part="header">
    <span class="title">${escapeHtml(this.#labels.brand)}</span>
    <span class="actions">
      ${this.#page ? '' : '<button class="btn" data-act="tab">new tab ↗</button>'}
      ${this.#page ? '' : '<button class="close" data-act="close">×</button>'}
    </span>
  </div>
  <div class="session">
    <span class="session-label">session</span>
    ${
      this.#feed.currentSessionId === null
        ? '<span class="muted">none live</span>'
        : `<code class="session-id">${escapeHtml(this.#feed.currentSessionId)}</code>
           <button class="btn" data-copy="${escapeHtml(this.#feed.currentSessionId)}">copy</button>`
    }
  </div>
  <div class="tabs">${this.#tabsHtml()}</div>
  <div class="feed">${this.#feedHtml()}</div>
  <div class="footer">${escapeHtml(this.#labels.footer)}</div>
</div>`;
    this.#wirePanel();
  }

  #tabsHtml(): string {
    const tabs: Array<[TabId, string, boolean]> = [
      ['agent', this.#labels.agent, true],
      ['telemetry', this.#labels.telemetry, this.#caps.telemetry],
      ['data', this.#labels.data, this.#caps.data],
    ];
    return tabs
      .filter(([, , available]) => available)
      .map(
        ([id, label]) =>
          `<button class="tab${this.#tab === id ? ' tab--active' : ''}" data-tab="${id}">${escapeHtml(label)}</button>`,
      )
      .join('');
  }

  #feedHtml(): string {
    if (this.#tab === 'telemetry') return this.#telemetryHtml();
    if (this.#tab === 'data') return this.#dataHtml();
    return this.#agentHtml();
  }

  /**
   * Turns and details merged by the collector's global `seq`, grouped under
   * session dividers — so "which session was that" stays answerable after a
   * reset.
   */
  #agentHtml(): string {
    type Item = {
      sort: number;
      sessionId: string;
      turn?: AgentDebugEvent;
      detail?: TurnDetailEvent;
    };
    const items: Item[] = [
      ...this.#feed.events.map((turn) => ({ sort: turn.seq, sessionId: turn.sessionId, turn })),
      ...this.#feed.details.map((detail) => ({
        sort: detail.seq,
        sessionId: detail.sessionId,
        detail,
      })),
    ].sort((a, b) => b.sort - a.sort);

    if (items.length === 0)
      return `<div class="empty">${escapeHtml(this.#labels.emptyAgent)}</div>`;

    const out: string[] = [];
    let lastSession: string | null = null;
    for (const item of items) {
      if (item.sessionId !== lastSession) {
        out.push(
          `<div class="divider"><code>${escapeHtml(item.sessionId)}</code>
           <button class="btn" data-copy="${escapeHtml(item.sessionId)}">copy</button></div>`,
        );
        lastSession = item.sessionId;
      }
      out.push(
        item.turn ? this.#turnHtml(item.turn) : this.#detailHtml(item.detail as TurnDetailEvent),
      );
    }
    return out.join('');
  }

  #turnHtml(event: AgentDebugEvent): string {
    return `<div class="row">
  <span class="time">${escapeHtml(timeOf(event.at))}</span>
  <span class="tag">${escapeHtml(event.surface)}</span>
  <span class="lane">${event.lane === undefined ? '' : `${escapeHtml(event.lane)} → `}<strong>${escapeHtml(event.model)}</strong>${
    event.workflow ? ` <em>· ${escapeHtml(event.workflow)}</em>` : ''
  }</span>
  <button class="btn" data-copy="${escapeHtml(event.sessionId)}">copy</button>
  ${event.preview ? `<span class="preview">“${escapeHtml(event.preview)}”</span>` : ''}
</div>`;
  }

  #detailHtml(detail: TurnDetailEvent): string {
    const time = `<span class="time">${escapeHtml(timeOf(detail.at))}</span>`;
    if (detail.kind === 'tool_call') {
      return `<div class="detail">${time}<span class="tool">⚙ ${escapeHtml(detail.tool)}${
        detail.input ? `<span class="tool-input"> — ${escapeHtml(detail.input)}</span>` : ''
      }</span></div>`;
    }
    if (detail.kind === 'thinking') {
      return `<div class="detail">${time}<span>∴ reasoning (${(detail.chars / 1000).toFixed(1)}k)
        <span class="thinking-preview">“${escapeHtml(detail.preview)}”</span></span></div>`;
    }
    if (detail.kind === 'turn_error') {
      return `<div class="detail detail--error">${time}<span>✗ ${escapeHtml(detail.error)}</span></div>`;
    }
    const tools =
      detail.tools.length > 0 ? ` <em>(${escapeHtml(detail.tools.join(', '))})</em>` : '';
    const tokens =
      detail.tokensIn !== undefined ? ` · ${detail.tokensIn}→${detail.tokensOut ?? '?'} tok` : '';
    const cost = detail.cost !== undefined ? ` · $${detail.cost.toFixed(4)}` : '';
    return `<div class="detail detail--end">${time}<span>■ ${escapeHtml(detail.finishReason)} · ${
      detail.toolCalls
    } tool call${detail.toolCalls === 1 ? '' : 's'}${tools} · reasoning ${(detail.thinkingChars / 1000).toFixed(1)}k · reply ${(
      detail.textChars / 1000
    ).toFixed(1)}k${escapeHtml(tokens)}${escapeHtml(cost)}</span></div>`;
  }

  #telemetryHtml(): string {
    if (this.#telemetry.length === 0)
      return `<div class="empty">${escapeHtml(this.#labels.emptyTelemetry)}</div>`;
    return this.#telemetry
      .map((event) => {
        const slow = event.durationMs !== undefined && event.durationMs > 1000;
        const failed = event.status !== undefined && event.status >= 400;
        return `<div class="row">
  <span class="time">${escapeHtml(timeOf(event.at))}</span>
  <span class="tag">${escapeHtml(event.category)}</span>
  <span class="lane">${escapeHtml(event.name)}${event.detail ? ` <em>${escapeHtml(event.detail)}</em>` : ''}</span>
  ${event.status === undefined ? '' : `<span class="status${failed ? ' status--bad' : ''}">${event.status}</span>`}
  ${event.durationMs === undefined ? '' : `<span class="ms${slow ? ' ms--slow' : ''}">${event.durationMs}ms</span>`}
</div>`;
      })
      .join('');
  }

  #dataHtml(): string {
    if (this.#data.length === 0)
      return `<div class="empty">${escapeHtml(this.#labels.emptyData)}</div>`;
    return this.#data
      .map(
        (event) => `<div class="row">
  <span class="time">${escapeHtml(timeOf(event.at))}</span>
  ${event.ref ? `<span class="ref">${escapeHtml(event.ref)}</span>` : ''}
  ${(event.labels ?? []).map((l) => `<span class="label-chip">[${escapeHtml(l)}]</span>`).join('')}
  <span class="lane">${escapeHtml(event.summary)}</span>
</div>`,
      )
      .join('');
  }

  // ── interaction ───────────────────────────────────────────────────────────

  #wirePill(): void {
    const pill = this.#root.querySelector('.pill');
    if (!(pill instanceof HTMLElement)) return;
    this.#makeDraggable(pill, pill);
    pill.addEventListener('click', () => {
      // A click that ended a drag is a drop, not an open.
      if (this.#dragged) return;
      this.#open = true;
      this.#render();
      this.#syncPolling();
      void this.refresh();
    });
  }

  #wirePanel(): void {
    const root = this.#root;
    const panel = root.querySelector('.panel');
    const header = root.querySelector('.header');
    if (panel instanceof HTMLElement && header instanceof HTMLElement && !this.#page) {
      this.#makeDraggable(header, panel);
    }

    root.querySelector('[data-act="close"]')?.addEventListener('click', () => {
      this.#open = false;
      this.#render();
      this.#syncPolling();
    });
    root.querySelector('[data-act="tab"]')?.addEventListener('click', () => {
      window.open(this.getAttribute('standalone-href') ?? '/debug', '_blank', 'noopener');
    });
    for (const tab of root.querySelectorAll('[data-tab]')) {
      tab.addEventListener('click', () => {
        this.#tab = (tab as HTMLElement).dataset.tab as TabId;
        this.#render();
      });
    }
    for (const copy of root.querySelectorAll('[data-copy]')) {
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText((copy as HTMLElement).dataset.copy ?? '');
        copy.textContent = 'copied';
        setTimeout(() => {
          copy.textContent = 'copy';
        }, 1200);
      });
    }
  }

  /**
   * Drag `moved` by its `handle`. A 4px threshold keeps a click from being
   * eaten by a 1px wobble, and the result is clamped to the viewport so nothing
   * can be dragged somewhere unreachable.
   */
  #makeDraggable(handle: HTMLElement, moved: HTMLElement): void {
    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('button:not(.pill)')) return;
      const rect = moved.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      let didMove = false;
      handle.setPointerCapture?.(event.pointerId);

      const onMove = (moveEvent: PointerEvent): void => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!didMove && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        didMove = true;
        const x = Math.min(Math.max(0, rect.left + dx), window.innerWidth - 60);
        const y = Math.min(Math.max(0, rect.top + dy), window.innerHeight - 32);
        this.#pos = { x, y };
        moved.style.left = `${x}px`;
        moved.style.top = `${y}px`;
        moved.style.right = 'auto';
        moved.style.bottom = 'auto';
      };
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        this.#dragged = didMove;
        // Cleared on the next tick: the click event fires after pointerup, and
        // the flag exists only to let that one click know it was a drop.
        if (didMove) {
          setTimeout(() => {
            this.#dragged = false;
          }, 0);
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }
}
