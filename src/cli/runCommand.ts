// `sov run` — one-shot machine-readable harness contract.
//
// This is the adapter surface for tools that need to drive the coding harness
// without scraping the human `sov drive` transcript. The first contract is
// intentionally narrow: `sov run --json --stdin` reads all stdin as one prompt,
// runs exactly one turn through the same in-process HTTP+SSE server the TUI uses,
// echoes typed server events as JSONL, then emits a final machine event.

import { Buffer } from 'node:buffer';
import type { ReasoningEffort } from '@yevgetman/sov-sdk/providers/effort';
import { PreflightError, SessionNotFoundError } from '../server/errors.js';
import type { ServerEvent } from '../server/schema.js';
import { DriveSseManager } from './driveCommand.js';

export type RunOptions = {
  json?: unknown;
  stdin?: unknown;
  bundle?: unknown;
  provider?: unknown;
  model?: unknown;
  permissionMode?: unknown;
  maxTokens?: unknown;
  db?: unknown;
  resume?: unknown;
  cache?: unknown;
  preflight?: unknown;
  effort?: unknown;
  /** Catch-all so Commander option bags don't trip the type. */
  [k: string]: unknown;
};

export type RunCommandIO = {
  readStdin?: () => Promise<string>;
  writeStdout?: (s: string) => void;
  writeStderr?: (s: string) => void;
};

type JsonObject = Record<string, unknown>;

type PostTurnResult = { ok: true } | { ok: false; error: string };

type TerminalState =
  | {
      type: 'completed';
      sessionId: string;
      finishReason: string;
      usage?: unknown;
    }
  | {
      type: 'error';
      sessionId: string;
      error: string;
      recoverable: boolean;
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

function pickEffort(value: unknown): ReasoningEffort | undefined {
  if (
    value === 'off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max'
  ) {
    return value;
  }
  return undefined;
}

export async function runRunCommand(opts: RunOptions, io: RunCommandIO = {}): Promise<number> {
  const writeStdout =
    io.writeStdout ??
    ((s: string): void => {
      process.stdout.write(s);
    });
  const writeStderr =
    io.writeStderr ??
    ((s: string): void => {
      process.stderr.write(s);
    });
  const writeJson = (obj: JsonObject | ServerEvent): void => {
    writeStdout(`${JSON.stringify(obj)}\n`);
  };

  if (pickBoolean(opts.json) !== true || pickBoolean(opts.stdin) !== true) {
    writeStderr('sov run: the initial machine contract requires --json and --stdin\n');
    return 2;
  }

  let prompt: string;
  try {
    prompt = await (io.readStdin ?? readProcessStdin)();
  } catch (err) {
    const error = `failed to read stdin: ${err instanceof Error ? err.message : String(err)}`;
    writeJson({ type: 'turn.error', sessionId: null, error, recoverable: false });
    return 1;
  }

  if (prompt.trim().length === 0) {
    writeJson({
      type: 'turn.error',
      sessionId: null,
      error: 'stdin prompt is empty',
      recoverable: false,
    });
    return 2;
  }

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
  const effort = pickEffort(opts.effort);
  if (effort !== undefined) buildOpts.effort = effort;
  if (pickBoolean(opts.cache) === false) buildOpts.cacheEnabled = false;
  if (pickBoolean(opts.preflight) === false) buildOpts.preflight = false;

  let runtime: Awaited<ReturnType<typeof buildRuntime>>;
  try {
    runtime = await buildRuntime(buildOpts);
  } catch (err) {
    const error =
      err instanceof PreflightError
        ? `provider preflight failed (${err.kind}): ${err.message}`
        : err instanceof SessionNotFoundError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
    writeJson({ type: 'turn.error', sessionId: null, error, recoverable: false });
    return 1;
  }

  let server: { port: number; stop: () => Promise<void> } | null = null;
  let sse: DriveSseManager<JsonRunRenderer> | null = null;
  let rendererRef: JsonRunRenderer | null = null;
  // Headless interrupt handling — a process signal (Ctrl-C, an adapter
  // timeout/kill, a scheduler stop) must still produce a machine terminal
  // event so the caller isn't left reading a truncated JSONL stream, and
  // must let the `finally` below tear down the in-process server + runtime.
  // The handler only flips a flag and cancels the turn wait; the main flow
  // then emits the terminal `turn.error` and returns the conventional
  // 128+signum exit code (130 SIGINT / 143 SIGTERM). The session is
  // persisted, so the error is marked recoverable and the adapter can resume.
  let interruptSignal: 'SIGINT' | 'SIGTERM' | null = null;
  const onSignal = (sig: 'SIGINT' | 'SIGTERM') => (): void => {
    if (interruptSignal !== null) return;
    interruptSignal = sig;
    rendererRef?.cancelAwait();
  };
  const onInt = onSignal('SIGINT');
  const onTerm = onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  try {
    try {
      server = await startServer({ runtime });
    } catch (err) {
      const error = `failed to start server: ${err instanceof Error ? err.message : String(err)}`;
      writeJson({ type: 'turn.error', sessionId: null, error, recoverable: false });
      return 1;
    }

    const baseURL = `http://127.0.0.1:${server.port}`;
    const resumed = runtime.resumeId !== undefined;
    const sessionId =
      runtime.resumeId ??
      (await createSession({ baseURL }).catch((err: unknown) => {
        throw new Error(
          `failed to create session: ${err instanceof Error ? err.message : String(err)}`,
        );
      }));

    writeJson({
      type: 'session.started',
      sessionId,
      resumed,
      provider: runtime.resolvedProvider.transport.name,
      model: runtime.model,
      permissionMode: runtime.permissionMode,
      effort: runtime.effort,
    });

    const renderer = new JsonRunRenderer({ baseURL, writeJson });
    rendererRef = renderer;
    sse = new DriveSseManager({
      baseURL,
      initialSessionId: sessionId,
      renderer,
    });
    sse.start();

    const turnDone = renderer.awaitTurnTerminal();
    // A signal that arrived after handler registration but before the turn
    // wait existed (e.g. during createSession) left the flag set with no live
    // await to cancel. Cancel now so `await turnDone` resolves immediately
    // and the interrupt branch below emits the terminal event.
    if (interruptSignal !== null) renderer.cancelAwait();
    const post = await postRunTurn({ baseURL, sessionId: sse.activeSessionId, text: prompt });
    if (!post.ok) {
      renderer.cancelAwait();
      writeJson({
        type: 'turn.error',
        sessionId: sse.activeSessionId,
        error: post.error,
        recoverable: false,
      });
      return 1;
    }

    await turnDone;

    if (interruptSignal !== null) {
      writeJson({
        type: 'turn.error',
        sessionId: sse.activeSessionId,
        error: 'interrupted',
        recoverable: true,
      });
      return interruptSignal === 'SIGINT' ? 130 : 143;
    }

    const terminal = renderer.terminal;
    if (terminal === null) {
      writeJson({
        type: 'turn.error',
        sessionId: sse.activeSessionId,
        error: 'turn stream ended without a terminal event',
        recoverable: false,
      });
      return 1;
    }

    if (terminal.type === 'error') {
      writeJson({
        type: 'turn.error',
        sessionId: sse.activeSessionId,
        ...(terminal.sessionId !== sse.activeSessionId
          ? { terminalSessionId: terminal.sessionId }
          : {}),
        error: terminal.error,
        recoverable: terminal.recoverable,
      });
      return 1;
    }

    writeJson({
      type: 'turn.completed',
      sessionId: sse.activeSessionId,
      ...(terminal.sessionId !== sse.activeSessionId
        ? { terminalSessionId: terminal.sessionId }
        : {}),
      reply: renderer.reply,
      finishReason: terminal.finishReason,
      ...(terminal.usage !== undefined ? { usage: terminal.usage } : {}),
    });
    return 0;
  } catch (err) {
    writeJson({
      type: 'turn.error',
      sessionId: null,
      error: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
    return 1;
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    rendererRef = null;
    if (sse !== null) await sse.stop();
    if (server !== null) await server.stop();
    await runtime.dispose();
  }
}

class JsonRunRenderer {
  private readonly baseURL: string;
  private readonly writeJson: (obj: JsonObject | ServerEvent) => void;
  private readonly textParts: string[] = [];
  private turnTerminalResolver: (() => void) | null = null;
  private pendingTurnPromise: Promise<void> | null = null;
  terminal: TerminalState | null = null;

  constructor(opts: { baseURL: string; writeJson: (obj: JsonObject | ServerEvent) => void }) {
    this.baseURL = opts.baseURL;
    this.writeJson = opts.writeJson;
  }

  get reply(): string {
    return this.textParts.join('');
  }

  awaitTurnTerminal(): Promise<void> {
    if (this.pendingTurnPromise !== null) return this.pendingTurnPromise;
    this.pendingTurnPromise = new Promise<void>((resolve) => {
      this.turnTerminalResolver = resolve;
    });
    return this.pendingTurnPromise;
  }

  cancelAwait(): void {
    if (this.turnTerminalResolver !== null) {
      this.turnTerminalResolver();
      this.turnTerminalResolver = null;
      this.pendingTurnPromise = null;
    }
  }

  handle(ev: ServerEvent): void {
    this.writeJson(ev);
    switch (ev.type) {
      case 'text_delta':
        this.textParts.push(ev.text);
        return;
      case 'turn_complete':
        this.terminal = {
          type: 'completed',
          sessionId: ev.sessionId,
          finishReason: ev.finishReason,
          ...(ev.usage !== undefined ? { usage: ev.usage } : {}),
        };
        this.resolveTurn();
        return;
      case 'turn_error':
        this.terminal = {
          type: 'error',
          sessionId: ev.sessionId,
          error: ev.error,
          recoverable: ev.recoverable,
        };
        this.resolveTurn();
        return;
      case 'permission_request':
        autoDenyPermission({
          baseURL: this.baseURL,
          requestId: ev.requestId,
          sessionId: ev.sessionId,
        }).catch(() => {});
        return;
      default:
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

async function createSession(opts: { baseURL: string }): Promise<string> {
  const res = await fetch(`${opts.baseURL}/sessions`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST /sessions returned ${res.status}${body ? `: ${body}` : ''}`);
  }
  const body = (await res.json()) as { sessionId?: unknown };
  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
    throw new Error('POST /sessions did not return a sessionId');
  }
  return body.sessionId;
}

async function postRunTurn(opts: {
  baseURL: string;
  sessionId: string;
  text: string;
}): Promise<PostTurnResult> {
  try {
    const res = await fetch(`${opts.baseURL}/sessions/${opts.sessionId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: opts.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        error: `POST /turns ${res.status}${body ? `: ${body}` : ''}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `POST /turns network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function autoDenyPermission(opts: {
  baseURL: string;
  requestId: string;
  sessionId: string;
}): Promise<void> {
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

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
