// Phase 10.6 — local-model router types. The router is a meta-provider:
// it implements LLMProvider but per turn picks between two configured
// child providers (a "local" provider and a "frontier" provider) and
// records the decision. Frontier escalation is explicit and audited;
// the runtime never silently ships data to the cloud lane.

export type Lane = 'local' | 'frontier';
export type ClassifierLane = Lane | 'local-with-escalation';

export type EscalationMode = 'ask' | 'auto' | 'never';

export type RouterConfig = {
  /** When the classifier produces 'local-with-escalation' but no override
   *  triggers fire, fall back to this lane. Default: 'local'. */
  defaultLane?: Lane;
  /** Provider name (e.g. 'ollama') the router resolves for the local lane. */
  localProvider: string;
  /** Optional model override for the local provider. */
  localModel?: string;
  /** Provider name (e.g. 'anthropic') for the frontier lane. */
  frontierProvider: string;
  /** Optional model override for the frontier provider. */
  frontierModel?: string;
  /** Behavior when the classifier flags 'local-with-escalation':
   *  'ask' (default): defer to the user (current build: equivalent to
   *  'never' until an interactive prompt lands).
   *  'auto': escalate to frontier without asking.
   *  'never': stay local. */
  escalationMode?: EscalationMode;
};

export type ClassifyOpts = {
  /** Concatenated user prompt text for this turn. */
  prompt: string;
  /** Total context byte count (system + history + this prompt). */
  contextByteCount?: number;
  /** Tool errors observed in the rolling window. */
  recentToolErrors?: number;
  /** Schema-validation failures observed in the rolling window. */
  recentSchemaFailures?: number;
  /** When set, bypasses the classifier rules entirely. */
  userOverride?: Lane;
  /** Local provider's context length, for the overflow check. */
  localContextLength?: number;
};

export type RouteDecision = {
  /** Resolved lane after override / escalation policy. */
  lane: Lane;
  /** Raw classifier output (may be 'local-with-escalation' which then
   *  resolves through escalationMode). */
  classifierLane: ClassifierLane;
  /** Human-readable summary of why this lane was chosen. */
  reason: string;
};
