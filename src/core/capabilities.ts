// Relocated from the proprietary `router/` directory (SDK open-core
// extraction): `findCapableModel` and its supporting capability-profile
// table are pure leaves with no proprietary dependencies, so they live in
// the open core. The former `router/` module is now a re-export of this
// one, preserving the proprietary import path. Body below is unchanged.

// Phase 13.2 — model capability profiles. A small per-model record carrying
// the behavioral hints the runtime actually needs at decision points:
// context length, coarse cost tier, tool-call and JSON reliability, and the
// roles a model is recommended for.
//
// Two consumers:
//   1. The router classifier reads `contextLength` to set the context-
//      overflow trigger threshold (Phase 10.6 already plumbed this through
//      RouterProviderOpts.localContextLength — capabilities.ts is the
//      source of truth from here).
//   2. The Phase 13 sub-agent scheduler reads `recommendedRoles` to
//      resolve agent definitions that declare `role: explore` instead of
//      a literal model — picks the cheapest available model whose
//      `recommendedRoles` includes the requested role.
//
// v0 entries are hand-curated from public spec sheets and conservative
// reads of community evals. Phase 13.4 (continuous-learning observation
// stream) will refine these from real-world usage; entries with
// `source: 'eval'` will indicate the calibration came from harness
// trajectories rather than vendor docs.

export type CapabilityRole =
  | 'explore' // codebase mapping, file search, single-claim verification
  | 'verify' // independent skeptical check on a claim
  | 'plan' // implementation planning, surface mapping
  | 'code' // writing or editing source code
  | 'draft' // long-form writing, summaries
  | 'classify' // small label / classification tasks
  | 'agent'; // capable of multi-turn tool-use as a primary agent

export type CapabilityProfile = {
  provider: string;
  model: string;
  contextLength: number;
  /** Coarse cost ordering. Lower = cheaper. v0 buckets:
   *    0 = local (ollama / on-device)
   *    1 = cheap frontier (haiku, gpt-4o-mini)
   *    2 = mid frontier (sonnet)
   *    3 = expensive frontier (opus, gpt-4o-2024)
   *  Precise per-token pricing is intentionally NOT modeled here; that
   *  belongs in a billing module if it ever becomes load-bearing. */
  costTier: number;
  /** Tool-calling reliability in [0, 1]. */
  toolCallReliability: number;
  /** Structured-output (JSON-schema) reliability in [0, 1]. */
  jsonReliability: number;
  /** Roles this model is recommended for. The scheduler matches an
   *  agent's declared role against this list. */
  recommendedRoles: CapabilityRole[];
  /** Where the numbers came from. v0 is all 'curated'; Phase 13.4 will
   *  graduate refined entries to 'eval'. */
  source: 'curated' | 'eval';
};

export const CAPABILITY_TABLE: CapabilityProfile[] = [
  // ── Local lane (ollama) ──────────────────────────────────────────────
  {
    provider: 'ollama',
    model: 'qwen2.5:3b',
    contextLength: 32_768,
    costTier: 0,
    toolCallReliability: 0.55,
    jsonReliability: 0.55,
    recommendedRoles: ['explore', 'classify'],
    source: 'curated',
  },
  {
    provider: 'ollama',
    model: 'qwen2.5:7b',
    contextLength: 32_768,
    costTier: 0,
    toolCallReliability: 0.7,
    jsonReliability: 0.7,
    recommendedRoles: ['explore', 'verify', 'classify'],
    source: 'curated',
  },
  {
    provider: 'ollama',
    model: 'qwen2.5:14b',
    contextLength: 32_768,
    costTier: 0,
    toolCallReliability: 0.78,
    jsonReliability: 0.78,
    recommendedRoles: ['explore', 'verify', 'plan', 'classify'],
    source: 'curated',
  },
  {
    provider: 'ollama',
    model: 'qwen2.5:32b',
    contextLength: 32_768,
    costTier: 0,
    toolCallReliability: 0.85,
    jsonReliability: 0.85,
    recommendedRoles: ['explore', 'verify', 'plan', 'draft', 'classify', 'agent'],
    source: 'curated',
  },
  {
    provider: 'ollama',
    model: 'llama3.1:8b',
    contextLength: 128_000,
    costTier: 0,
    toolCallReliability: 0.65,
    jsonReliability: 0.65,
    recommendedRoles: ['explore', 'classify'],
    source: 'curated',
  },
  {
    provider: 'ollama',
    model: 'llama3.1:70b',
    contextLength: 128_000,
    costTier: 0,
    toolCallReliability: 0.85,
    jsonReliability: 0.85,
    recommendedRoles: ['explore', 'verify', 'plan', 'draft', 'agent'],
    source: 'curated',
  },
  {
    provider: 'ollama',
    model: 'mistral-nemo',
    contextLength: 128_000,
    costTier: 0,
    toolCallReliability: 0.7,
    jsonReliability: 0.7,
    recommendedRoles: ['explore', 'verify', 'classify'],
    source: 'curated',
  },

  // ── Frontier lane (Anthropic) ────────────────────────────────────────
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    contextLength: 200_000,
    costTier: 1,
    toolCallReliability: 0.95,
    jsonReliability: 0.95,
    recommendedRoles: ['explore', 'verify', 'plan', 'code', 'draft', 'classify', 'agent'],
    source: 'curated',
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-20241022',
    contextLength: 200_000,
    costTier: 1,
    toolCallReliability: 0.92,
    jsonReliability: 0.92,
    recommendedRoles: ['explore', 'verify', 'plan', 'code', 'draft', 'classify'],
    source: 'curated',
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    contextLength: 200_000,
    costTier: 2,
    toolCallReliability: 0.97,
    jsonReliability: 0.97,
    recommendedRoles: ['explore', 'verify', 'plan', 'code', 'draft', 'classify', 'agent'],
    source: 'curated',
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    contextLength: 200_000,
    costTier: 3,
    toolCallReliability: 0.98,
    jsonReliability: 0.98,
    recommendedRoles: ['explore', 'verify', 'plan', 'code', 'draft', 'classify', 'agent'],
    source: 'curated',
  },

  // ── Frontier lane (OpenAI) ───────────────────────────────────────────
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    contextLength: 128_000,
    costTier: 1,
    toolCallReliability: 0.9,
    jsonReliability: 0.9,
    recommendedRoles: ['explore', 'verify', 'plan', 'classify'],
    source: 'curated',
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    contextLength: 128_000,
    costTier: 2,
    toolCallReliability: 0.95,
    jsonReliability: 0.95,
    recommendedRoles: ['explore', 'verify', 'plan', 'code', 'draft', 'classify', 'agent'],
    source: 'curated',
  },

  // ── Frontier lane (OpenRouter — Anthropic-via-OpenRouter aliases) ────
  {
    provider: 'openrouter',
    model: 'anthropic/claude-haiku-4.5',
    contextLength: 200_000,
    costTier: 1,
    toolCallReliability: 0.95,
    jsonReliability: 0.95,
    recommendedRoles: ['explore', 'verify', 'plan', 'code', 'draft', 'classify', 'agent'],
    source: 'curated',
  },
];

/** Look up a capability profile by exact `(provider, model)` match.
 *  Returns undefined when the table doesn't carry an entry — callers
 *  should fall through to whatever default they used pre-Phase-13.2. */
export function getCapabilityProfile(
  provider: string,
  model: string,
): CapabilityProfile | undefined {
  return CAPABILITY_TABLE.find((p) => p.provider === provider && p.model === model);
}

/** Find the cheapest profile (lowest costTier) whose recommendedRoles
 *  includes `role` AND whose provider is in the `availableProviders` list.
 *  Returns undefined when no profile matches. The caller decides what to
 *  do — typically fall back to a configured default model. */
export function findCapableModel(
  role: string,
  availableProviders: readonly string[],
): CapabilityProfile | undefined {
  const allowed = new Set(availableProviders);
  const candidates = CAPABILITY_TABLE.filter(
    (p) => allowed.has(p.provider) && (p.recommendedRoles as readonly string[]).includes(role),
  );
  if (candidates.length === 0) return undefined;
  candidates.sort(
    (a, b) =>
      a.costTier - b.costTier ||
      // Tiebreak: prefer higher reliability within the same tier.
      b.toolCallReliability - a.toolCallReliability ||
      a.model.localeCompare(b.model),
  );
  return candidates[0];
}
