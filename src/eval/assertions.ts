// Phase 10.5 part 2 — assertion primitives for goldens. Each evaluator
// is pure: takes a sandbox cwd + a captured agent transcript, returns
// pass/fail + a one-line detail when failing. The runner calls these
// after the subprocess exits.
//
// Assertions are intentionally simple and string/regex-based. Higher-
// fidelity matching (AST, content-type-aware) is out of scope for the
// MVP — once a golden actually needs it, add the kind here.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Assertion, AssertionResult } from './types.js';

export type EvaluateOpts = {
  /** Absolute path to the sandbox cwd that the agent ran inside. */
  sandboxCwd: string;
  /** ANSI-stripped stdout transcript (everything the user would see). */
  transcript: string;
  /** Subprocess exit code. */
  exitCode: number;
  /** Tool call totals parsed from the session-summary footer. */
  toolCalls?: { ok: number; err: number };
};

/** Evaluate a single assertion against the captured run state. */
export function evaluateAssertion(assertion: Assertion, opts: EvaluateOpts): AssertionResult {
  switch (assertion.type) {
    case 'fileExists':
      return checkFileExists(assertion.path, opts.sandboxCwd, true, assertion);
    case 'fileNotExists':
      return checkFileExists(assertion.path, opts.sandboxCwd, false, assertion);
    case 'fileContains':
      return checkFileContains(assertion.path, assertion.text, opts.sandboxCwd, assertion);
    case 'fileMatches':
      return checkFileMatches(
        assertion.path,
        assertion.pattern,
        assertion.flags,
        opts.sandboxCwd,
        assertion,
      );
    case 'fileEquals':
      return checkFileEquals(assertion.path, assertion.content, opts.sandboxCwd, assertion);
    case 'agentResponseContains':
      return checkTranscriptContains(opts.transcript, assertion.text, assertion);
    case 'agentResponseMatches':
      return checkTranscriptMatches(opts.transcript, assertion.pattern, assertion.flags, assertion);
    case 'agentResponseLacks':
      return checkTranscriptLacks(opts.transcript, assertion.text, assertion);
    case 'noToolErrors':
      return checkNoToolErrors(opts.toolCalls, assertion);
    case 'minToolCalls':
      return checkMinToolCalls(opts.toolCalls, assertion.count, assertion);
    case 'maxToolCalls':
      return checkMaxToolCalls(opts.toolCalls, assertion.count, assertion);
    case 'exitCode':
      return checkExitCode(opts.exitCode, assertion.code, assertion);
  }
}

/** Convenience: evaluate every assertion in order, return all results. */
export function evaluateAll(assertions: Assertion[], opts: EvaluateOpts): AssertionResult[] {
  return assertions.map((a) => evaluateAssertion(a, opts));
}

function checkFileExists(
  path: string,
  cwd: string,
  shouldExist: boolean,
  assertion: Assertion,
): AssertionResult {
  const full = join(cwd, path);
  const exists = existsSync(full);
  const pass = exists === shouldExist;
  if (pass) return { assertion, pass };
  return {
    assertion,
    pass,
    detail: shouldExist ? `expected ${path} to exist` : `expected ${path} to NOT exist`,
  };
}

function checkFileContains(
  path: string,
  text: string,
  cwd: string,
  assertion: Assertion,
): AssertionResult {
  const full = join(cwd, path);
  if (!existsSync(full)) {
    return { assertion, pass: false, detail: `${path} does not exist` };
  }
  const content = readFileSync(full, 'utf8');
  if (content.includes(text)) return { assertion, pass: true };
  return {
    assertion,
    pass: false,
    detail: `${path} does not contain ${JSON.stringify(text)}`,
  };
}

function checkFileMatches(
  path: string,
  pattern: string,
  flags: string | undefined,
  cwd: string,
  assertion: Assertion,
): AssertionResult {
  const full = join(cwd, path);
  if (!existsSync(full)) {
    return { assertion, pass: false, detail: `${path} does not exist` };
  }
  const content = readFileSync(full, 'utf8');
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { assertion, pass: false, detail: `invalid regex: ${msg}` };
  }
  if (re.test(content)) return { assertion, pass: true };
  return {
    assertion,
    pass: false,
    detail: `${path} does not match /${pattern}/${flags ?? ''}`,
  };
}

function checkFileEquals(
  path: string,
  expected: string,
  cwd: string,
  assertion: Assertion,
): AssertionResult {
  const full = join(cwd, path);
  if (!existsSync(full)) {
    return { assertion, pass: false, detail: `${path} does not exist` };
  }
  const content = readFileSync(full, 'utf8');
  if (content === expected) return { assertion, pass: true };
  const truncate = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
  return {
    assertion,
    pass: false,
    detail: `${path} content mismatch: got ${JSON.stringify(truncate(content))}, expected ${JSON.stringify(truncate(expected))}`,
  };
}

function checkTranscriptContains(
  transcript: string,
  text: string,
  assertion: Assertion,
): AssertionResult {
  if (transcript.includes(text)) return { assertion, pass: true };
  return {
    assertion,
    pass: false,
    detail: `transcript does not contain ${JSON.stringify(text)}`,
  };
}

function checkTranscriptMatches(
  transcript: string,
  pattern: string,
  flags: string | undefined,
  assertion: Assertion,
): AssertionResult {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { assertion, pass: false, detail: `invalid regex: ${msg}` };
  }
  if (re.test(transcript)) return { assertion, pass: true };
  return {
    assertion,
    pass: false,
    detail: `transcript does not match /${pattern}/${flags ?? ''}`,
  };
}

function checkTranscriptLacks(
  transcript: string,
  text: string,
  assertion: Assertion,
): AssertionResult {
  if (!transcript.includes(text)) return { assertion, pass: true };
  return {
    assertion,
    pass: false,
    detail: `transcript unexpectedly contains ${JSON.stringify(text)}`,
  };
}

function checkNoToolErrors(
  toolCalls: { ok: number; err: number } | undefined,
  assertion: Assertion,
): AssertionResult {
  if (!toolCalls) {
    return {
      assertion,
      pass: false,
      detail: 'tool-call totals not parsed from session summary',
    };
  }
  if (toolCalls.err === 0) return { assertion, pass: true };
  return {
    assertion,
    pass: false,
    detail: `${toolCalls.err} tool error(s) observed`,
  };
}

function checkMinToolCalls(
  toolCalls: { ok: number; err: number } | undefined,
  count: number,
  assertion: Assertion,
): AssertionResult {
  if (!toolCalls) {
    return {
      assertion,
      pass: false,
      detail: 'tool-call totals not parsed from session summary',
    };
  }
  const total = toolCalls.ok + toolCalls.err;
  if (total >= count) return { assertion, pass: true };
  return {
    assertion,
    pass: false,
    detail: `expected ≥ ${count} tool calls, observed ${total}`,
  };
}

function checkMaxToolCalls(
  toolCalls: { ok: number; err: number } | undefined,
  count: number,
  assertion: Assertion,
): AssertionResult {
  if (!toolCalls) {
    return {
      assertion,
      pass: false,
      detail: 'tool-call totals not parsed from session summary',
    };
  }
  const total = toolCalls.ok + toolCalls.err;
  if (total <= count) return { assertion, pass: true };
  return {
    assertion,
    pass: false,
    detail: `expected ≤ ${count} tool calls, observed ${total}`,
  };
}

function checkExitCode(actual: number, expected: number, assertion: Assertion): AssertionResult {
  if (actual === expected) return { assertion, pass: true };
  return {
    assertion,
    pass: false,
    detail: `expected exit code ${expected}, got ${actual}`,
  };
}
