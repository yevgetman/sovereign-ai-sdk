// `sov drive` — headless line-driven LLM conversation surface.
//
// Built 2026-05-22 to restore the headless surface the semantic test
// suite needed after M13 removed `terminalRepl`. The TUI is the only
// user-facing surface; `sov drive` is the test/automation surface that
// speaks the same protocol the TUI client does (HTTP + SSE against the
// in-process Hono server), but emits plain-text events to stdout
// instead of rendering a Bubble Tea program.
//
// Protocol (mirrors dispatchCommand's READY_MARKER / TURN_SEPARATOR
// shape so semantic-test transcripts read consistently across both
// surfaces):
//   1. Boot completes — `--- ready ---` on its own line.
//   2. For each newline-delimited stdin line:
//      a. If `/quit` → clean exit.
//      b. If starts with `/` → POST /sessions/:id/commands; the response
//         body is rendered to stdout.
//      c. Otherwise → POST /sessions/:id/turns and drain the SSE stream
//         until `turn_complete` or `turn_error` arrives. Events render
//         as plain text: text_delta accumulates onto stdout, tool calls
//         emit `[<tool>: <input-preview>]` lines, tool results emit
//         their summary + optional raw output (gated on --verbose-raw).
//      d. `--- end-of-turn ---` on its own line.
//   3. On stdin EOF or after `/quit`: stop the server, dispose the
//      runtime, return 0.
//
// Permission requests in headless mode auto-deny — there's no human at
// the keyboard to approve. Tests that need approvals use
// --permission-mode bypass (the default in the semantic-test driver)
// or the deny path under --permission-mode default.

import { createInterface } from 'node:readline/promises';
import { PreflightError, SessionNotFoundError } from '../server/errors.js';
import type { ServerEvent } from '../server/schema.js';
import { parseServerEvent } from '../server/schema.js';

export const READY_MARKER = '--- ready ---';
export const TURN_SEPARATOR = '--- end-of-turn ---';
export const ERROR_MARKER = '--- error ---';

export type DriveOptions = {
  bundle?: unknown;
  provider?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  maxTokens?: unknown;
  db?: unknown;
  resume?: unknown;
  cache?: unknown;
  preflight?: unknown;
  /** When true, append raw tool Output below each tool_result line.
   *  Default false — only the compact summary appears. */
  verboseRaw?: unknown;
  /** Catch-all so Commander option bags don't trip the type. */
  [k: string]: unknown;
};

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pickPermissionMode(value: unknown): 'default' | 'ask' | 'bypass' | undefined {
  if (value === 'default' || value === 'ask' || value === 'bypass') return value;
  return undefined;
}

export async function runDriveCommand(opts: DriveOptions): Promise<number> {
  const { buildRuntime } = await import('../server/runtime.js');
  const { startServer } = await import('../server/index.js');

  const buildOpts: Parameters<typeof buildRuntime>[0] = {
    cwd: process.cwd(),
  };
  const bundle = pickString(opts.bundle);
  if (bundle !== undefined) buildOpts.bundleRoot = bundle;
  const provider = pickString(opts.provider);
  if (provider !== undefined) buildOpts.provider = provider;
  const model = pickString(opts.model);
  if (model !== undefined) buildOpts.model = model;
  const permissionMode = pickPermissionMode(opts.permissionMode);
  if (permissionMode !== undefined) buildOpts.permissionMode = permissionMode;
  const maxTokens = pickNumber(opts.maxTokens);
  if (maxTokens !== undefined) buildOpts.maxTokens = maxTokens;
  const db = pickString(opts.db);
  if (db !== undefined) buildOpts.dbPath = db;
  const resume = pickString(opts.resume);
  if (resume !== undefined) buildOpts.resumeId = resume;
  if (pickBoolean(opts.cache) === false) buildOpts.cacheEnabled = false;
  if (pickBoolean(opts.preflight) === false) buildOpts.preflight = false;
  const verboseRaw = pickBoolean(opts.verboseRaw) === true;

  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  try {
    runtime = await buildRuntime(buildOpts);
  } catch (err) {
    if (err instanceof PreflightError) {
      process.stderr.write(`sov: provider preflight failed (${err.kind}): ${err.message}\n`);
      return 1;
    }
    if (err instanceof SessionNotFoundError) {
      process.stderr.write(`sov: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  let server: { port: number; stop: () => Promise<void> } | null = null;
  try {
    server = await startServer({ runtime });
  } catch (err) {
    process.stderr.write(
      `sov: failed to start server: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await runtime.dispose();
    return 1;
  }

  // Create or resume session.
  let sessionId: string;
  if (runtime.resumeId !== undefined) {
    sessionId = runtime.resumeId;
  } else {
    try {
      const createRes = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: 'POST',
      });
      if (!createRes.ok) {
        throw new Error(`POST /sessions returned ${createRes.status}`);
      }
      const body = (await createRes.json()) as { sessionId: string };
      sessionId = body.sessionId;
    } catch (err) {
      process.stderr.write(
        `sov: failed to create session: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await server.stop();
      await runtime.dispose();
      return 1;
    }
  }

  const baseURL = `http://127.0.0.1:${server.port}`;

  // SSE connection lifecycle: the server closes the per-session stream
  // after every turn_complete / turn_error (src/server/routes/events.ts
  // drops the subscriber + disposes the bus). The TUI reconnects on
  // each sseDoneMsg (packages/tui/internal/app/app.go:1052-1053); we do
  // the same here via a loop that re-calls drainSseStream after every
  // natural close. Between connections we briefly pause so the new
  // connection finishes opening before the next POST /turns fires
  // (events that arrive during the gap are buffered on the per-session
  // bus and delivered when the new consumer subscribes).
  let activeSessionId = sessionId;
  const sseController = new AbortController();
  const renderer = new EventRenderer(verboseRaw, baseURL);
  const sessionIdRef = {
    get current(): string {
      return activeSessionId;
    },
  };
  // Reconnect cursor shared across every drainSseStream call: the highest seq
  // observed, sent as `Last-Event-ID` so a post-turn reconnect resumes AFTER
  // the terminal instead of re-receiving (and re-rendering) the whole turn.
  const sseCursor = { current: null as number | null };
  const onEvent = (ev: ServerEvent): void => {
    renderer.handle(ev);
    if (ev.type === 'compaction_complete' && ev.activeSessionId) {
      activeSessionId = ev.activeSessionId;
      // The pivoted session is a NEW bus with its own seq space starting at 1.
      // Reset the cursor so the next reconnect is a fresh subscriber (current-
      // turn replay) rather than a stale-cursor resume that would skip the new
      // bus's lower-numbered events.
      sseCursor.current = null;
    }
  };
  const sseDone = (async () => {
    while (!sseController.signal.aborted) {
      try {
        await drainSseStream({
          baseURL,
          sessionIdRef,
          signal: sseController.signal,
          onEvent,
          cursorRef: sseCursor,
        });
      } catch {
        // ignore — drainSseStream throws when the signal aborts; the
        // loop's outer while-guard catches that. Other errors are also
        // recoverable (next POST /turns will trigger a reconnect).
      }
      if (sseController.signal.aborted) break;
      // Yield the event loop briefly so the next iteration's fetch()
      // doesn't race the just-closed connection's cleanup.
      await new Promise((r) => setTimeout(r, 20));
    }
  })();

  process.stdout.write(`${READY_MARKER}\n`);

  const rl = createInterface({ input: process.stdin });
  let exitRequested = false;

  try {
    for await (const rawLine of rl) {
      if (exitRequested) break;
      const line = rawLine.trim();
      if (!line) {
        process.stdout.write(`${TURN_SEPARATOR}\n`);
        continue;
      }
      if (line === '/quit' || line === '/exit') {
        exitRequested = true;
        break;
      }

      if (line.startsWith('/')) {
        await runSlashCommand({ baseURL, sessionId: activeSessionId, line, renderer });
      } else {
        // POST a turn, then await the renderer's per-turn promise that
        // resolves on turn_complete OR turn_error.
        const turnDone = renderer.awaitTurnTerminal();
        const ok = await postTurn({ baseURL, sessionId: activeSessionId, text: line });
        if (!ok) {
          renderer.cancelAwait();
        } else {
          await turnDone;
        }
      }
      process.stdout.write(`${TURN_SEPARATOR}\n`);
    }
    return 0;
  } finally {
    rl.close();
    sseController.abort();
    try {
      await sseDone;
    } catch {
      // ignore — abort triggers a reader error we don't surface
    }
    if (server !== null) await server.stop();
    await runtime.dispose();
  }
}

// --- Event rendering ------------------------------------------------------

export class EventRenderer {
  private verboseRaw: boolean;
  private baseURL: string;
  private write: (s: string) => void;
  private turnTerminalResolver: (() => void) | null = null;
  private pendingTurnPromise: Promise<void> | null = null;

  constructor(
    verboseRaw: boolean,
    baseURL: string,
    write: (s: string) => void = (s) => {
      process.stdout.write(s);
    },
  ) {
    this.verboseRaw = verboseRaw;
    this.baseURL = baseURL;
    this.write = write;
  }

  /** Returns a promise that resolves the next time a turn-terminal event
   *  (turn_complete | turn_error | session_summary) is observed. The
   *  caller awaits this after POSTing /turns. */
  awaitTurnTerminal(): Promise<void> {
    if (this.pendingTurnPromise !== null) return this.pendingTurnPromise;
    this.pendingTurnPromise = new Promise<void>((resolve) => {
      this.turnTerminalResolver = resolve;
    });
    return this.pendingTurnPromise;
  }

  /** Resolve the pending turn promise without waiting for a real event.
   *  Used when /turns POST fails — no SSE event will arrive. */
  cancelAwait(): void {
    if (this.turnTerminalResolver !== null) {
      this.turnTerminalResolver();
      this.turnTerminalResolver = null;
      this.pendingTurnPromise = null;
    }
  }

  handle(ev: ServerEvent): void {
    switch (ev.type) {
      case 'text_delta':
        this.write(ev.text);
        return;
      case 'thinking_delta':
        // Thinking text is dim/italic in the TUI; here we surface it on
        // a dedicated line so the judge can tell agent thinking from
        // agent text. Kept in transcript for tests that look for
        // reasoning traces.
        this.write(`\n[thinking] ${ev.text}\n`);
        return;
      case 'tool_use_start': {
        // tool_use_start carries the tool name only; the inputPartial
        // field may be undefined (the input streams in via subsequent
        // tool_use_input_delta events, and the final input appears on
        // tool_result.input). Print the tool name now and let
        // tool_result print the full input + output.
        this.write(`\n[tool ${ev.tool}]\n`);
        return;
      }
      case 'tool_result': {
        // Print the tool name + a flattened input preview so the judge
        // sees what was invoked, then a compact summary of the output.
        // With --verbose-raw, append the raw Output so test criteria
        // that look for tool-output substrings (e.g., "the transcript
        // shows the literal string '<token>'") can match.
        const inputPreview = previewInput(ev.input);
        if (inputPreview !== '') {
          this.write(`[input ${ev.tool}] ${inputPreview}\n`);
        }
        const out = renderToolOutput(ev.output);
        const summary = out.summary !== '' ? out.summary : '(no summary)';
        this.write(`[result ${ev.tool}] ${summary}\n`);
        if (this.verboseRaw && out.raw !== '') {
          this.write(`${out.raw}\n`);
        }
        return;
      }
      case 'turn_complete':
        this.write(`\n[turn_complete ${ev.finishReason}]\n`);
        this.resolveTurn();
        return;
      case 'turn_error':
        this.write(`\n[turn_error ${ev.error}]\n`);
        this.resolveTurn();
        return;
      case 'session_summary':
        this.write('\n[session_summary]\n');
        this.resolveTurn();
        return;
      case 'permission_request':
        // Headless mode has no human to approve — auto-deny so the
        // turn proceeds with a permission-denied tool result instead
        // of blocking forever on the approval queue. The semantic-test
        // suite runs with --permission-mode bypass for happy-path tests
        // and --permission-mode default for permission tests; default-
        // mode tests rely on layered deny rules firing BEFORE the
        // approval queue ever fires permission_request. This auto-deny
        // is the safety net for the residual case where a tool's
        // self-check returns 'ask' under default mode (or future tests
        // that opt into 'ask' mode explicitly).
        this.write(`\n[permission_request ${ev.tool}] auto-denying (headless)\n`);
        autoDenyPermission({
          baseURL: this.baseURL,
          requestId: ev.requestId,
          sessionId: ev.sessionId,
        }).catch(() => {});
        return;
      case 'delegator_plan': {
        const count =
          ev.scheduledAtomCount !== undefined ? ` ${ev.scheduledAtomCount} atom(s)` : '';
        this.write(`[delegator_plan] dispatching${count}\n`);
        return;
      }
      case 'delegator_atom_started': {
        this.write(
          `[delegator_atom ${ev.atomIndex}] starting on ${ev.laneName}: ${ev.promptPreview}\n`,
        );
        return;
      }
      case 'delegator_atom_complete': {
        const result = ev.success ? 'ok' : 'failed';
        this.write(
          `[delegator_atom ${ev.atomIndex}] complete on ${ev.laneName} (${ev.durationMs}ms) ${result}\n`,
        );
        return;
      }
      case 'delegator_complete': {
        const dist = Object.entries(ev.laneDistribution)
          .sort(([, a], [, b]) => b - a)
          .map(([lane, count]) => `${lane}=${count}`)
          .join(', ');
        this.write(`[delegator_complete] ${ev.totalAtomCount} atoms${dist ? `: ${dist}` : ''}\n`);
        return;
      }
      case 'status_update':
      case 'session_resumed':
      case 'compaction_complete':
      case 'stall_detected':
      case 'tool_use_input_delta':
      case 'tool_use_done':
        // These don't need plain-text rendering for semantic tests;
        // tool_result + text_delta carry the substantive observable
        // behavior. compaction_complete updates the session id via
        // the onEvent hook in drainSseStream.
        return;
    }
  }

  private resolveTurn(): void {
    if (this.turnTerminalResolver !== null) {
      this.turnTerminalResolver();
      this.turnTerminalResolver = null;
      this.pendingTurnPromise = null;
    }
  }
}

export function previewInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
  } catch {
    return '<unprintable input>';
  }
}

/** Extract a one-line summary + the full raw text from a tool_result
 *  Output JSON. Tool outputs are typically a JSON envelope `{ status,
 *  summary, content?, ... }` — we lift `summary` and stringify the rest
 *  as `raw`.
 *
 *  STRING outputs are the common case for tools whose `renderResult` emits
 *  text (notably AgentTool — native AND subscription-executor delegations).
 *  The orchestrator renders those as an observation header (`status:` /
 *  `summary:` lines, see renderObservationHeader in core/orchestrator.ts)
 *  followed by the tool's own body, and the wire carries that string verbatim.
 *  We recover a one-line summary from such a string — preferring a
 *  `<subagent_result>` body (the delegated answer the model saw) and falling
 *  back to the observation-header `summary:` line — so a delegation surfaces
 *  in `sov drive` instead of printing "(no summary)". A bare string with no
 *  recognizable summary (e.g. the deny path "permission denied: ...") still
 *  passes through as raw with no summary. */
export function renderToolOutput(output: unknown): { summary: string; raw: string } {
  if (output === null || output === undefined) return { summary: '', raw: '' };
  if (typeof output === 'string') {
    return { summary: extractSummaryFromString(output), raw: output };
  }
  if (typeof output === 'object') {
    const obj = output as { summary?: unknown; content?: unknown; status?: unknown };
    const summary = typeof obj.summary === 'string' ? obj.summary : '';
    // Render everything (including summary) as the raw body so tests
    // looking for any field's substring can match. We don't strip
    // 'summary' from the dump — duplication is cheap, the test driver
    // strips ANSI but not duplicates.
    let raw: string;
    try {
      raw = JSON.stringify(output, null, 2);
    } catch {
      raw = String(output);
    }
    return { summary, raw };
  }
  return { summary: '', raw: String(output) };
}

/** Recover a one-line summary from a STRING tool_result body. Two shapes, in
 *  priority order:
 *
 *   1. A `<subagent_result …>…</subagent_result>` block (AgentTool, native +
 *      subscription-executor) — the inner body is the delegated answer the
 *      model saw. Whitespace-flattened to a single line.
 *   2. An observation-header `summary: <text>` line (every tool whose result
 *      carries the Phase-12.5 envelope header, see renderObservationHeader).
 *
 *  Returns '' when neither shape is present (a bare string passes through with
 *  no summary, e.g. the orchestrator deny path). Pure + allocation-light. */
function extractSummaryFromString(text: string): string {
  const delegated = extractSubagentResultBody(text);
  if (delegated !== '') return delegated;
  return extractObservationHeaderSummary(text);
}

/** Pull the inner body of the first `<subagent_result …>…</subagent_result>`
 *  block, whitespace-flattened to one line. '' when absent or empty-bodied. */
function extractSubagentResultBody(text: string): string {
  const open = text.indexOf('<subagent_result');
  if (open < 0) return '';
  const bodyStart = text.indexOf('>', open);
  if (bodyStart < 0) return '';
  const close = text.indexOf('</subagent_result>', bodyStart);
  const body = close < 0 ? text.slice(bodyStart + 1) : text.slice(bodyStart + 1, close);
  return body.replace(/\s+/g, ' ').trim();
}

/** Pull the value of the first `summary: <text>` observation-header line.
 *  Header lines precede the tool body and are single-line by construction
 *  (renderObservationHeader joins with '\n'). '' when absent. */
function extractObservationHeaderSummary(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('summary:')) {
      return trimmed.slice('summary:'.length).trim();
    }
    // The header is a contiguous block at the top; a blank line ends it.
    if (trimmed === '') break;
  }
  return '';
}

// --- HTTP helpers ----------------------------------------------------------

async function postTurn(opts: {
  baseURL: string;
  sessionId: string;
  text: string;
}): Promise<boolean> {
  try {
    const res = await fetch(`${opts.baseURL}/sessions/${opts.sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: opts.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stdout.write(`\n${ERROR_MARKER}\nPOST /turns ${res.status}: ${body}\n`);
      return false;
    }
    return true;
  } catch (err) {
    process.stdout.write(
      `\n${ERROR_MARKER}\nPOST /turns network error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

async function runSlashCommand(opts: {
  baseURL: string;
  sessionId: string;
  line: string;
  renderer: EventRenderer;
}): Promise<void> {
  // Parse `/name args...` — split on first whitespace.
  const trimmed = opts.line.startsWith('/') ? opts.line.slice(1) : opts.line;
  const spaceAt = trimmed.search(/\s/);
  const name = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  const args = spaceAt === -1 ? '' : trimmed.slice(spaceAt + 1).trim();

  try {
    const res = await fetch(`${opts.baseURL}/sessions/${opts.sessionId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stdout.write(`${ERROR_MARKER}\nPOST /commands ${res.status}: ${body}\n`);
      return;
    }
    const body = (await res.json()) as {
      output?: string;
      error?: string;
      promptToSend?: string;
    };
    if (body.error) {
      process.stdout.write(`${ERROR_MARKER}\n${body.error}\n`);
      return;
    }
    if (body.output) {
      process.stdout.write(`${body.output}\n`);
    }
    // Prompt-type slash commands (/init, /commit, every skill-sourced
    // command, etc.) come back with a `promptToSend` field — the
    // expanded prompt body, ready to POST as a turn. Auto-send it so
    // semantic tests (and any other automation) get the agent's
    // response. The TUI client adopts the same field separately; here
    // we keep the contract simple: command returns immediately after
    // the prompt-send + SSE-drain. 2026-05-22 PM.
    if (body.promptToSend !== undefined && body.promptToSend !== '') {
      const turnDone = opts.renderer.awaitTurnTerminal();
      const ok = await postTurn({
        baseURL: opts.baseURL,
        sessionId: opts.sessionId,
        text: body.promptToSend,
      });
      if (!ok) {
        opts.renderer.cancelAwait();
      } else {
        await turnDone;
      }
    }
  } catch (err) {
    process.stdout.write(
      `${ERROR_MARKER}\nPOST /commands network error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function autoDenyPermission(opts: {
  baseURL: string;
  requestId: string;
  sessionId: string;
}): Promise<void> {
  // POST `{approved: false}` to /approvals so the runtime stops
  // waiting on the queue and surfaces a permission-denied tool result
  // to the agent. Errors are swallowed — if the route is gone or the
  // session has been torn down, there's nothing useful we can do here
  // (the runtime would have failed the turn anyway).
  try {
    await fetch(`${opts.baseURL}/sessions/${opts.sessionId}/approvals/${opts.requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    });
  } catch {
    // ignore
  }
}

// --- SSE stream consumer ---------------------------------------------------

async function drainSseStream(opts: {
  baseURL: string;
  sessionIdRef: { readonly current: string };
  signal: AbortSignal;
  onEvent: (ev: ServerEvent) => void;
  // Shared reconnect cursor. We send the highest seq seen as `Last-Event-ID`
  // on (re)connect so the server replays only events AFTER it. Without this, a
  // reconnect after a turn terminal is a fresh (no-cursor) subscriber and the
  // bus replays the whole just-completed turn — INCLUDING turn_complete — which
  // ends this stream again, so we reconnect and re-receive it forever: an
  // infinite loop that re-streams the same assistant turn. `current` is updated
  // to each event's seq as it arrives so the NEXT reconnect resumes correctly.
  cursorRef: { current: number | null };
}): Promise<void> {
  const url = `${opts.baseURL}/sessions/${opts.sessionIdRef.current}/events`;
  const headers =
    opts.cursorRef.current !== null
      ? { 'Last-Event-ID': String(opts.cursorRef.current) }
      : undefined;
  const res = await fetch(url, { signal: opts.signal, ...(headers ? { headers } : {}) });
  if (!res.ok || res.body === null) {
    throw new Error(`SSE GET ${url} returned ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let blockEnd = buffer.indexOf('\n\n');
      while (blockEnd !== -1) {
        const block = buffer.slice(0, blockEnd);
        buffer = buffer.slice(blockEnd + 2);
        const ev = parseEventBlock(block);
        if (ev !== null) {
          // Advance the reconnect cursor BEFORE handling so a throw in onEvent
          // can't make us re-request (and re-render) an event we already saw.
          opts.cursorRef.current = ev.seq;
          opts.onEvent(ev);
        }
        blockEnd = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

export function parseEventBlock(block: string): ServerEvent | null {
  let dataLine: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('data: ')) {
      dataLine = line.slice('data: '.length);
      // Don't break — the last data: line wins for multi-line SSE
      // payloads, but our publisher emits single-line data; this loop
      // is defensive against future format changes.
    }
  }
  if (dataLine === null) return null;
  return parseServerEvent(dataLine);
}
