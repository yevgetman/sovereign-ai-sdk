// Settings schema. Zod-validated; strict (unknown keys rejected). Phase 5
// adds provider defaults and credentials; later phases add project layering.
//
// Source of pattern: Claude Code src/schemas/.

import { z } from 'zod';

const CredentialConfigSchema = z
  .object({
    id: z.string().optional(),
    apiKey: z.string().optional(),
    token: z.string().optional(),
    priority: z.number().int().optional(),
  })
  .strict();

const ProviderConfigSchema = z
  .object({
    apiKey: z.string().optional(),
    apiKeys: z.array(z.string()).optional(),
    credentials: z.array(CredentialConfigSchema).optional(),
    model: z.string().optional(),
    baseUrl: z.string().url().optional(),
    strategy: z.enum(['ROUND_ROBIN', 'LEAST_USED', 'FILL_FIRST']).optional(),
    /** Ollama only: explicit num_ctx override sent on every request.
     *  Defaults to the model's registered contextLength when unset. */
    numCtx: z.number().int().positive().optional(),
  })
  .strict();

const MicrocompactionSchema = z
  .object({
    enabled: z.boolean().optional(),
    keepRecent: z.number().int().positive().optional(),
    triggerThresholdPct: z.number().min(0).max(100).optional(),
  })
  .strict();

const CompactionSchema = z
  .object({
    /** When the system prompt + history exceeds this percentage of the
     *  model's context window, the REPL preemptively compacts the
     *  session before the next provider call. Default 75. The compactor
     *  also self-guards: if the frozen system prompt alone exceeds the
     *  threshold, compaction stops firing (it can't make progress, it
     *  only summarizes message history). Lower toward 50 if you want
     *  earlier compaction; raise toward 90 to keep more history before
     *  triggering. */
    proactiveThresholdPct: z.number().min(1).max(99).optional(),
  })
  .strict();

/** Wave-1+3 REPL polish (Phase 10.5b/d). All flags optional and
 *  default to enabled / sensible thresholds; the schema is strict so
 *  unknown keys surface as zod validation errors rather than silently
 *  being ignored. */
const UiSchema = z
  .object({
    /** Active color theme. Built-ins: dark, light, no-color. Default
     *  is 'dark' (preserves the original look). NO_COLOR env var is
     *  honored automatically and overrides the configured value. */
    theme: z.enum(['dark', 'light', 'no-color']).optional(),
    /** Pre-prompt status line (provider/model · ctx % · cost · perms ·
     *  tools) printed above the input frame. Default true. Set false
     *  for non-TTY scripts where the line just adds noise. */
    footer: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Context-utilization meter thresholds (percent, 0..100). The
     *  footer turns yellow at warn and red at danger; the REPL emits a
     *  one-shot pre-compaction warning when crossing into warn. */
    contextMeter: z
      .object({
        warnAtPercent: z.number().min(0).max(100).optional(),
        dangerAtPercent: z.number().min(0).max(100).optional(),
      })
      .strict()
      .optional(),
    /** Inline diff renderer for FileEdit / FileWrite results. Default
     *  true — the user always sees what the agent changed. Setting
     *  false reverts to the one-line "ok · N lines" summary. */
    diffRender: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Compact tool slot — how the REPL renders each tool call's
     *  inline output below the call header. Default 10 lines; the
     *  surplus is summarized in the footer ("· +N more lines"). Set
     *  inlineLines: 0 to revert to the pre-polish behavior of header
     *  + footer only with no inline content. --verbose flag bypasses
     *  this entirely and renders the full result. */
    toolOutput: z
      .object({
        inlineLines: z.number().int().min(0).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Developer-facing flags pinned for harness building/debugging. The
 *  umbrella `enabled` flag is a convenience switch — when true, every
 *  child capability behaves as if it were also true. Children can still
 *  be set individually for fine-grained control when the umbrella is
 *  unset. The CLI can still override individual settings per session. */
const DebugModeSchema = z
  .object({
    /** Master switch. When true, all child capabilities (currently:
     *  `transcript`) auto-enable regardless of their individual values. */
    enabled: z.boolean().optional(),
    /** When true (or when `enabled` is true), each REPL session writes a
     *  redacted JSONL transcript under `transcriptDir`. */
    transcript: z.boolean().optional(),
    /** Directory for auto-generated transcript files. Tilde and
     *  relative paths are expanded against the harness home /
     *  process cwd at REPL startup. Defaults to `<harnessHome>/debug`
     *  (i.e. `~/.harness/debug`). */
    transcriptDir: z.string().optional(),
  })
  .strict();

/** Backlog item 24 — cost-control knobs for interactive sessions.
 *  All fields optional; defaults documented at the call site. */
const BehaviorSchema = z
  .object({
    /** When set, the turn loop pauses after this many cumulative tool
     *  calls in a single user turn and asks the user whether to continue.
     *  Default unset (no limit). Useful for vague prompts that might
     *  trigger unintended long autonomous runs. */
    maxToolCallsBeforeCheckin: z.number().int().positive().optional(),
  })
  .strict();

export const SettingsSchema = z
  .object({
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    permissionMode: z.enum(['default', 'ask', 'bypass']).optional(),
    /** Maximum number of model turns inside a single user query before
     *  the runtime stops with `[max turns reached]`. One turn = one
     *  assistant message; tool_use turns count, so analysis tasks that
     *  read many files need a higher cap. Default 100 — high enough to
     *  function as a runaway-loop circuit breaker rather than a task
     *  ceiling, mirroring Claude Code's "rely on permission gates +
     *  Ctrl-C, not a numeric cap" model. */
    maxTurns: z.number().int().positive().optional(),
    /** When true, show the full tool-result preview block (40 lines /
     *  4000 chars) under each `[tool: ...]` header. Default off — the
     *  REPL just prints a one-line summary so the agent's tool output
     *  doesn't dominate the conversation view. CLI `--verbose` overrides. */
    verbose: z.boolean().optional(),
    /** WebSearch tool configuration. Sets the search provider and the
     *  API key. Falls back to TAVILY_API_KEY / BRAVE_SEARCH_API_KEY env
     *  vars when the config-side key is unset. */
    webSearch: z
      .object({
        provider: z.enum(['tavily', 'brave']).optional(),
        apiKey: z.string().optional(),
        maxResults: z.number().int().min(1).max(20).optional(),
      })
      .strict()
      .optional(),
    providers: z
      .object({
        anthropic: ProviderConfigSchema.optional(),
        openai: ProviderConfigSchema.optional(),
        openrouter: ProviderConfigSchema.optional(),
        ollama: ProviderConfigSchema.optional(),
      })
      .strict()
      .optional(),
    /** Phase 10.6 — local-first router config. When `--provider router` is
     *  supplied, the runtime resolves the local + frontier child providers
     *  per this block and routes per turn via `src/router/`. */
    router: z
      .object({
        defaultLane: z.enum(['local', 'frontier']).optional(),
        localProvider: z.string(),
        localModel: z.string().optional(),
        frontierProvider: z.string(),
        frontierModel: z.string().optional(),
        escalationMode: z.enum(['ask', 'auto', 'never']).optional(),
        /** Phase 13.4 — global cap on concurrent local-lane provider calls.
         *  Both the router (single-session escalations) and the sub-agent
         *  scheduler (parent dispatching N children) acquire from the same
         *  per-lane semaphore. Undefined = unbounded. */
        maxConcurrentLocal: z.number().int().nonnegative().optional(),
        /** Phase 13.4 — same as maxConcurrentLocal but for the frontier lane. */
        maxConcurrentFrontier: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    microcompaction: MicrocompactionSchema.optional(),
    compaction: CompactionSchema.optional(),
    debugMode: DebugModeSchema.optional(),
    review: z
      .object({
        autoPromoteMemory: z.boolean().optional(),
        autoPromoteSkills: z.boolean().optional(),
        userTurnsForMemoryReview: z.number().int().positive().optional(),
        toolIterationsForSkillReview: z.number().int().positive().optional(),
        childReviewEveryN: z.number().int().positive().optional(),
        /** Phase 13.3 (A3) — minimum ms between two dispatches of the same
         *  review-fork agent type. Auto-triggered dispatches respect this
         *  floor; /review consolidate bypasses. Default 30000 (30s). */
        minIntervalMs: z.number().int().positive().optional(),
        disabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Phase 13.4 — continuous-learning observation stream + instinct
     *  corpus. All fields optional; defaults documented in the
     *  ReviewManager / LearningObserver code. */
    learning: z
      .object({
        /** When false, observation writer is a no-op + synthesizer never
         *  fires. Defaults to true. */
        disabled: z.boolean().optional(),
        /** Synthesizer runs every Nth user turn. Default 20. */
        synthesizerEveryN: z.number().int().positive().optional(),
        /** Backlog Item 10 — synthesizer also runs every Nth tool
         *  iteration. Independent from synthesizerEveryN — either counter
         *  can trip a dispatch. Default 50. */
        synthesizerEveryNToolIterations: z.number().int().positive().optional(),
        /** In-memory observation buffer cap before backpressure drops the
         *  oldest. Default 200. */
        observationBufferSize: z.number().int().positive().optional(),
        /** Confidence threshold below which instincts age out via
         *  `harness learning prune`. Default 0.3. */
        pruneBelowConfidence: z.number().min(0).max(1).optional(),
        /** Days without reinforcement after which sub-threshold instincts
         *  are pruned. Default 30. */
        pruneAgeDays: z.number().int().positive().optional(),
        /** Backlog Item 6 — tunable confidence math. All optional;
         *  defaults preserved when omitted. Future soak data should
         *  drive any changes here, not speculative tuning. */
        /** Logarithmic reinforcement coefficient. Default 0.04. */
        reinforcementCurveK: z.number().min(0).optional(),
        /** Per-unit contradiction drop. Default −0.2. Must be ≤ 0. */
        contradictionDelta: z.number().max(0).optional(),
        /** Confidence ceiling. Default 0.9. */
        confidenceCap: z.number().min(0).max(1).optional(),
        /** Starting-floor for newly proposed instincts. Default unset
         *  (effectively 0). When set, reinforce() treats current
         *  confidence as max(current, baseline) before the curve. */
        initialConfidenceBaseline: z.number().min(0).max(1).optional(),
        /** Cross-project promotion threshold (synthesizer surfaces
         *  candidates with confidence ≥ this). Default 0.7. */
        crossProjectMinConfidence: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    behavior: BehaviorSchema.optional(),
    ui: UiSchema.optional(),
    /** M9.5 — the Go TUI persists the active theme name as a top-level
     *  `theme` field in `~/.harness/config.json` (Go-side `internal/app/
     *  themeconfig.go`). The TS-side runtime does not render themes
     *  (REPL uses chalk; theme is a Go-renderer concern), so this field
     *  exists purely to satisfy strict-mode parsing. Accepts any string —
     *  built-ins (`dark`, `light`, `tokyo-night`, `sovereign`) plus
     *  user-defined TOML themes under `~/.harness/themes/<name>.toml`. */
    theme: z.string().optional(),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
