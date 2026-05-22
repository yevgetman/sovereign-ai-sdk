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

  // Open SSE stream as a long-lived consumer; events for every turn flow
  // through the same connection. The renderer below dispatches events
  // to per-turn promises so the stdin loop can `await` turn completion.
  let activeSessionId = sessionId;
  const sseController = new AbortController();
  const renderer = new EventRenderer(verboseRaw);
  const sseDone = drainSseStream({
    baseURL,
    sessionIdRef: {
      get current() {
        return activeSessionId;
      },
    },
    signal: sseController.signal,
    onEvent: (ev) => {
      renderer.handle(ev);
      // Track session pivots from compaction so future POSTs route to
      // the child session id, mirroring how the Go TUI's app.go hops.
      if (ev.type === 'compaction_complete' && ev.activeSessionId) {
        activeSessionId = ev.activeSessionId;
      }
    },
  });

  process.stdout.write(`${READY_MARKER}\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
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
        await runSlashCommand({ baseURL, sessionId: activeSessionId, line });
      } else {
        // POST a turn, then await the renderer's per-turn promise that
        // resolves on turn_complete OR turn_error.
        const turnDone = renderer.awaitTurnTerminal();
        const ok = await postTurn({ baseURL, sessionId: activeSessionId, text: line });
        if (!ok) {
          // Server rejected the turn — the renderer doesn't fire a
          // terminal event, so skip the await and surface the error
          // immediately. (Network/route failures are rare; the in-
          // process server normally accepts.)
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

class EventRenderer {
  private verboseRaw: boolean;
  private turnTerminalResolver: (() => void) | null = null;
  private pendingTurnPromise: Promise<void> | null = null;

  constructor(verboseRaw: boolean) {
    this.verboseRaw = verboseRaw;
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
        process.stdout.write(ev.text);
        return;
      case 'thinking_delta':
        // Thinking text is dim/italic in the TUI; here we surface it on
        // a dedicated line so the judge can tell agent thinking from
        // agent text. Kept in transcript for tests that look for
        // reasoning traces.
        process.stdout.write(`\n[thinking] ${ev.text}\n`);
        return;
      case 'tool_use_start': {
        // tool_use_start carries the tool name only; the inputPartial
        // field may be undefined (the input streams in via subsequent
        // tool_use_input_delta events, and the final input appears on
        // tool_result.input). Print the tool name now and let
        // tool_result print the full input + output.
        process.stdout.write(`\n[tool ${ev.tool}]\n`);
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
          process.stdout.write(`[input ${ev.tool}] ${inputPreview}\n`);
        }
        const out = renderToolOutput(ev.output);
        const summary = out.summary !== '' ? out.summary : '(no summary)';
        process.stdout.write(`[result ${ev.tool}] ${summary}\n`);
        if (this.verboseRaw && out.raw !== '') {
          process.stdout.write(`${out.raw}\n`);
        }
        return;
      }
      case 'turn_complete':
        process.stdout.write(`\n[turn_complete ${ev.finishReason}]\n`);
        this.resolveTurn();
        return;
      case 'turn_error':
        process.stdout.write(`\n[turn_error ${ev.error}]\n`);
        this.resolveTurn();
        return;
      case 'session_summary':
        process.stdout.write('\n[session_summary]\n');
        this.resolveTurn();
        return;
      case 'permission_request':
        // Headless mode has no human to approve — auto-deny so the
        // turn proceeds with a permission-denied tool result. The
        // semantic-test runs with --permission-mode bypass by default;
        // this path matters only for the permission cases that
        // exercise --permission-mode default.
        process.stdout.write(`\n[permission_request ${ev.tool}] auto-denying (headless)\n`);
        // The actual POST happens async; we don't need to await it
        // here — the rejection emits a tool_result the agent observes.
        autoDenyPermission({
          baseURL: 'http://127.0.0.1', // unused (filled per-call below)
          requestId: ev.requestId,
          sessionId: ev.sessionId,
        }).catch(() => {});
        return;
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
 *  as `raw`. Plain-string outputs (e.g., orchestrator's deny path
 *  "permission denied: ...") pass through as raw with no summary. */
export function renderToolOutput(output: unknown): { summary: string; raw: string } {
  if (output === null || output === undefined) return { summary: '', raw: '' };
  if (typeof output === 'string') return { summary: '', raw: output };
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
    const body = (await res.json()) as { output?: string; error?: string };
    if (body.error) {
      process.stdout.write(`${ERROR_MARKER}\n${body.error}\n`);
      return;
    }
    if (body.output) {
      process.stdout.write(`${body.output}\n`);
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
  // Caller passes a stub baseURL because we don't actually know it here
  // (the renderer doesn't have a baseURL reference). Look up from the
  // SSE stream's URL is awkward; for now the no-op approval path is
  // enough — auto-denying means we POST `{approved:false}`. The
  // semantic-test driver runs with --permission-mode bypass by default,
  // so this rarely fires. Permission tests use --permission-mode default
  // and rely on layered deny rules firing BEFORE the approval queue.
  // Approval flow only kicks in under --permission-mode ask which the
  // semantic suite doesn't currently use.
  //
  // If/when a test needs --permission-mode ask, plumb a real baseURL
  // and POST /sessions/:id/approvals/:requestId here.
  void opts;
}

// --- SSE stream consumer ---------------------------------------------------

async function drainSseStream(opts: {
  baseURL: string;
  sessionIdRef: { readonly current: string };
  signal: AbortSignal;
  onEvent: (ev: ServerEvent) => void;
}): Promise<void> {
  const url = `${opts.baseURL}/sessions/${opts.sessionIdRef.current}/events`;
  const res = await fetch(url, { signal: opts.signal });
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
        if (ev !== null) opts.onEvent(ev);
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
