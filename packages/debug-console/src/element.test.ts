// The element's contract, tested in a real DOM.
//
// happy-dom is registered per-file and torn down after, so the rest of the
// repo's `bun test` run keeps its plain Node globals.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
// Type-only, so it is erased at runtime and cannot pull element.js in before
// the DOM exists — which is the whole reason the value import below is dynamic.
import type { SovDebugConsoleElement as ConsoleElement } from './element.js';
import type { AgentFeed, DebugConsoleAdapter } from './types.js';

// The DOM must exist BEFORE element.js evaluates — it extends HTMLElement at
// module scope. Static imports hoist above any statement, so these two are
// loaded dynamically, after registration, and stay correct even if an import
// sorter reorders the block above.
GlobalRegistrator.register();
const { SovDebugConsoleElement } = await import('./element.js');
const { defineDebugConsole } = await import('./register.js');

// Registered globals are process-wide; hand them back so the rest of the
// repo's `bun test` run keeps its plain Node environment.
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const TAG = 'sov-debug-console';
defineDebugConsole(TAG);

const FEED: AgentFeed = {
  currentSessionId: 'sess-1',
  events: [
    {
      at: '2026-08-04T10:00:00.000Z',
      sessionId: 'sess-1',
      surface: 'chat',
      lane: 'chat',
      model: 'glm-5.2',
      preview: 'tailor my resume',
      seq: 10,
    },
  ],
  details: [
    {
      at: '2026-08-04T10:00:01.000Z',
      sessionId: 'sess-1',
      kind: 'tool_call',
      tool: 'Bash',
      input: 'resume tailor --branch main',
      eventSeq: 10,
      seq: 11,
    },
  ],
};

function mount(adapter: DebugConsoleAdapter | null): ConsoleElement {
  const element = document.createElement(TAG) as ConsoleElement;
  document.body.append(element);
  if (adapter !== null) element.adapter = adapter;
  return element;
}

/** Wait for the element's async refresh to settle and redraw. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function html(element: ConsoleElement): string {
  return element.shadowRoot?.innerHTML ?? '';
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('mounting', () => {
  test('renders the pill with no adapter at all and never throws', () => {
    const element = mount(null);

    expect(element.shadowRoot).not.toBeNull();
    expect(html(element)).toContain('class="pill"');
  });

  test('opening the pill reveals the panel', async () => {
    const element = mount({ getAgentFeed: async () => FEED });
    await settle();

    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    expect(html(element)).toContain('class="panel"');
  });
});

describe('capability gating', () => {
  test('a tab is ABSENT when its adapter method is absent', async () => {
    const element = mount({ getAgentFeed: async () => FEED });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    const tabs = [...(element.shadowRoot?.querySelectorAll('[data-tab]') ?? [])].map(
      (tab) => (tab as HTMLElement).dataset.tab,
    );
    expect(tabs).toEqual(['agent']);
  });

  test('supplying the methods reveals all three tabs', async () => {
    const element = mount({
      getAgentFeed: async () => FEED,
      getTelemetry: async () => [],
      getData: async () => [],
    });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    const tabs = [...(element.shadowRoot?.querySelectorAll('[data-tab]') ?? [])].map(
      (tab) => (tab as HTMLElement).dataset.tab,
    );
    expect(tabs).toEqual(['agent', 'telemetry', 'data']);
  });

  test('THE PROBE NEVER INVOKES — a present method is not called to test it', async () => {
    // The whole point: an empty-but-present surface must stay distinguishable
    // from an absent one, which calling-to-probe would destroy.
    let telemetryCalls = 0;
    mount({
      getAgentFeed: async () => FEED,
      getTelemetry: async () => {
        telemetryCalls += 1;
        return [];
      },
    });

    // Closed: refresh runs, but the probe itself contributed no extra call.
    await settle();
    expect(telemetryCalls).toBe(1);
  });

  test('a host with telemetry but no data gets a two-tab console', async () => {
    const element = mount({ getAgentFeed: async () => FEED, getTelemetry: async () => [] });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    expect(html(element)).toContain('data-tab="telemetry"');
    expect(html(element)).not.toContain('data-tab="data"');
  });

  test('switching to a tab whose method disappears falls back to agent', async () => {
    const element = mount({ getAgentFeed: async () => FEED, getTelemetry: async () => [] });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();
    element.shadowRoot?.querySelector<HTMLElement>('[data-tab="telemetry"]')?.click();

    element.adapter = { getAgentFeed: async () => FEED };
    await settle();

    expect(html(element)).not.toContain('data-tab="telemetry"');
    expect(html(element)).toContain('tab--active');
  });
});

describe('the agent tab', () => {
  test('renders the tool INPUT, not just the tool name', async () => {
    const element = mount({ getAgentFeed: async () => FEED });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    const markup = html(element);
    expect(markup).toContain('Bash');
    // The defect this guards: "Bash" alone tells nobody what ran.
    expect(markup).toContain('resume tailor --branch main');
  });

  test('groups rows under a session divider', async () => {
    const element = mount({ getAgentFeed: async () => FEED });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    expect(html(element)).toContain('class="divider"');
    expect(html(element)).toContain('sess-1');
  });

  test('escapes host-supplied text rather than injecting it as markup', async () => {
    const element = mount({
      getAgentFeed: async () => ({
        currentSessionId: null,
        events: [
          {
            at: '2026-08-04T10:00:00.000Z',
            sessionId: 's',
            surface: '<img src=x onerror=alert(1)>',
            model: 'm',
            seq: 1,
          },
        ],
        details: [],
      }),
    });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    expect(html(element)).not.toContain('<img src=x');
    expect(element.shadowRoot?.querySelector('img')).toBeNull();
  });

  test('shows an empty state rather than a blank panel', async () => {
    const element = mount({
      getAgentFeed: async () => ({ currentSessionId: null, events: [], details: [] }),
    });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    expect(html(element)).toContain('class="empty"');
  });
});

describe('resilience', () => {
  test('an adapter that rejects keeps the last good frame and emits an error event', async () => {
    let fail = false;
    const element = mount({
      getAgentFeed: async () => {
        if (fail) throw new Error('backend down');
        return FEED;
      },
    });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    let reported = '';
    element.addEventListener('sov-debug-error', (event: Event) => {
      reported = (event as CustomEvent<{ message: string }>).detail.message;
    });
    fail = true;
    await element.refresh();

    expect(reported).toBe('backend down');
    // Still showing what it last knew — tearing down mid-incident is the
    // opposite of useful.
    expect(html(element)).toContain('resume tailor --branch main');
  });
});

describe('registration', () => {
  test('defining the same tag twice is a no-op, not a throw', () => {
    expect(() => defineDebugConsole(TAG)).not.toThrow();
    expect(customElements.get(TAG)).toBe(SovDebugConsoleElement);
  });
});

describe('the data tab', () => {
  const dataRows = [
    {
      at: '2026-08-04T10:00:00.000Z',
      ref: 'abc1234',
      summary: 'add role',
      group: 'commits',
      seq: 1,
    },
    { at: '2026-08-04T10:01:00.000Z', summary: 'PUT /resume', group: 'http writes', seq: 2 },
    { at: '2026-08-04T10:02:00.000Z', summary: 'PUT /jobs', group: 'http writes', seq: 3 },
  ];

  test('emits a heading when the group CHANGES, not per row', async () => {
    const element = mount({ getAgentFeed: async () => FEED, getData: async () => dataRows });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();
    element.shadowRoot?.querySelector<HTMLElement>('[data-tab="data"]')?.click();

    const groups = [...(element.shadowRoot?.querySelectorAll('.group') ?? [])].map(
      (node) => node.textContent,
    );
    expect(groups).toEqual(['commits', 'http writes']);
    expect(element.shadowRoot?.querySelectorAll('.row')).toHaveLength(3);
  });

  test('ungrouped rows render with no headings at all', async () => {
    const element = mount({
      getAgentFeed: async () => FEED,
      getData: async () => [{ at: '2026-08-04T10:00:00.000Z', summary: 'a change', seq: 1 }],
    });
    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();
    element.shadowRoot?.querySelector<HTMLElement>('[data-tab="data"]')?.click();

    expect(element.shadowRoot?.querySelectorAll('.group')).toHaveLength(0);
    expect(element.shadowRoot?.innerHTML).toContain('a change');
  });
});

describe('launcher placement', () => {
  test('the pill is FIXED by default — it floats over the host page', async () => {
    const element = mount({ getAgentFeed: async () => FEED });
    await settle();

    const pill = element.shadowRoot?.querySelector('.pill');
    expect(pill?.classList.contains('pill--inline')).toBe(false);
  });

  test('inline placement puts the pill in normal flow for a host header', async () => {
    const element = mount({ getAgentFeed: async () => FEED });
    element.placement = 'inline';
    await settle();

    const pill = element.shadowRoot?.querySelector('.pill');
    expect(pill?.classList.contains('pill--inline')).toBe(true);
  });

  test('an inline pill still OPENS the panel, and the panel still floats', async () => {
    // Only the launcher moves into the host's chrome; a debug panel pinned
    // inside a header slot would be unusable.
    const element = mount({ getAgentFeed: async () => FEED });
    element.placement = 'inline';
    await settle();

    element.shadowRoot?.querySelector<HTMLElement>('.pill')?.click();
    await settle();

    const panel = element.shadowRoot?.querySelector('.panel');
    expect(panel).not.toBeNull();
    expect(panel?.classList.contains('panel--page')).toBe(false);
  });
});
