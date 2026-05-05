// Phase 10.6 — deterministic, conservative routing classifier. Inputs are
// the per-turn signals (user override, recent failures, context size,
// prompt text). Output is a RouteDecision: a lane plus the reason
// recorded for the audit log + the route_decision StreamEvent.
//
// The classifier is intentionally rule-based and explicit. No keyword
// "vibes" matching: the intent is that the user (or a downstream agent)
// can predict what the router will do given the inputs. Anything fuzzier
// is a learned-routing-policy concern (build plan §10.6 explicit skip).

import type { ClassifierLane, ClassifyOpts, Lane, RouteDecision, RouterConfig } from './types.js';

const TOOL_ERROR_THRESHOLD = 3;
const SCHEMA_FAILURE_THRESHOLD = 2;

/** Evaluate the routing rules and return the final lane + reason.
 *  The escalation policy resolves a 'local-with-escalation' classifier
 *  output to a concrete 'local' or 'frontier' lane. */
export function classify(config: RouterConfig, opts: ClassifyOpts): RouteDecision {
  const classifierLane = classifyRaw(opts);
  const lane = resolveLane(classifierLane, config);
  return {
    lane,
    classifierLane,
    reason: reasonFor(classifierLane, opts, config),
  };
}

/** The raw classifier — produces 'local', 'frontier', or
 *  'local-with-escalation' without consulting escalation mode. */
function classifyRaw(opts: ClassifyOpts): ClassifierLane {
  if (opts.userOverride === 'frontier') return 'frontier';
  if (opts.userOverride === 'local') return 'local';

  // Hard frontier triggers (always escalate, regardless of escalation
  // mode — these are situations where local is structurally unable to
  // continue, not just "might benefit from frontier").
  if (
    opts.localContextLength !== undefined &&
    opts.contextByteCount !== undefined &&
    opts.contextByteCount > opts.localContextLength * 4
  ) {
    // Rough heuristic: 4 bytes/token is a conservative upper bound for
    // English text + JSON. If the byte count exceeds 4 * context tokens,
    // the local model can't fit the prompt — frontier is the only path.
    return 'local-with-escalation';
  }

  if ((opts.recentToolErrors ?? 0) >= TOOL_ERROR_THRESHOLD) {
    return 'local-with-escalation';
  }
  if ((opts.recentSchemaFailures ?? 0) >= SCHEMA_FAILURE_THRESHOLD) {
    return 'local-with-escalation';
  }

  return 'local';
}

/** Apply the escalation policy to a 'local-with-escalation' classifier
 *  output. 'ask' currently degrades to 'never' (stay local) — interactive
 *  prompting lands in a follow-up. 'auto' escalates. */
function resolveLane(classifierLane: ClassifierLane, config: RouterConfig): Lane {
  if (classifierLane !== 'local-with-escalation') return classifierLane;
  const mode = config.escalationMode ?? 'ask';
  if (mode === 'auto') return 'frontier';
  // 'ask' or 'never' → stay on the configured default lane.
  return config.defaultLane ?? 'local';
}

function reasonFor(
  classifierLane: ClassifierLane,
  opts: ClassifyOpts,
  config: RouterConfig,
): string {
  if (opts.userOverride !== undefined) {
    return `user override → ${opts.userOverride}`;
  }
  if (classifierLane === 'frontier') {
    return 'classified as frontier-only';
  }
  if (classifierLane === 'local-with-escalation') {
    const triggers: string[] = [];
    if (
      opts.localContextLength !== undefined &&
      opts.contextByteCount !== undefined &&
      opts.contextByteCount > opts.localContextLength * 4
    ) {
      triggers.push(`context overflow (${opts.contextByteCount} bytes > local cap)`);
    }
    if ((opts.recentToolErrors ?? 0) >= TOOL_ERROR_THRESHOLD) {
      triggers.push(`tool errors >= ${TOOL_ERROR_THRESHOLD}`);
    }
    if ((opts.recentSchemaFailures ?? 0) >= SCHEMA_FAILURE_THRESHOLD) {
      triggers.push(`schema failures >= ${SCHEMA_FAILURE_THRESHOLD}`);
    }
    const mode = config.escalationMode ?? 'ask';
    const fallback = config.defaultLane ?? 'local';
    if (mode === 'auto') {
      return `escalate (${triggers.join(', ')})`;
    }
    return `${triggers.join(', ')}; escalation '${mode}' → stay ${fallback}`;
  }
  return 'default lane: local';
}
