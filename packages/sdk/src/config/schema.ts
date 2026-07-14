// Settings schema. Zod-validated; strict (unknown keys rejected). Phase 5
// adds provider defaults and credentials; later phases add project layering.
//
// Source of pattern: Claude Code src/schemas/.

import { z } from 'zod';
import { REASONING_EFFORTS } from '../providers/effort.js';

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

/** Router lane config: the base provider config PLUS static routing-hint
 *  `headers`. `headers` = Manifest custom-tier headers / `x-session-key` sent on
 *  every request — router lane ONLY (it exists here, not on ProviderConfigSchema,
 *  so it is never a silent no-op field on a non-router provider). */
const RouterProviderConfigSchema = ProviderConfigSchema.extend({
  headers: z.record(z.string()).optional(),
}).strict();

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
    /** How the TUI renders each tool_result event.
     *
     *  - `mode: 'compact'` (default) — one line per tool call in the
     *    style of the Claude mobile app:
     *      Edited app.go +11 -7  ›
     *      Read README.md         ›
     *      ⚠ Edit blocked.go      ›
     *      ✗ Bash $ build.sh      ›
     *    The trailing chevron is a visual hint that detail is available
     *    via `/expand N` (N is positional from most-recent).
     *  - `mode: 'detailed'` — the bordered ToolCard rendering with the
     *    output truncated to `inlineLines`. Reverts to the pre-2026-05-22
     *    behavior for users who want the inline preview.
     *  - `-v / --verbose` flag remains orthogonal — when set, the raw
     *    untruncated output prints below either mode's rendering.
     *
     *  `inlineLines` (default 10) caps the output in detailed mode.
     *  Set to 0 to collapse detailed mode to header-only. Range 0..200. */
    toolOutput: z
      .object({
        mode: z.enum(['compact', 'detailed']).optional(),
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
    /** Master switch. When true, debug capabilities auto-enable regardless of
     *  their individual values. Today: annotates the TUI delegator lines with
     *  the resolved lane provider/model. */
    enabled: z.boolean().optional(),
    /** DEPRECATED (2026-06-15) — superseded by the always-on `transcripts`
     *  block. Session transcripts are now written by default; this field is
     *  retained only so existing configs still parse and is otherwise ignored.
     *  Use `transcripts.enabled` to disable. */
    transcript: z.boolean().optional(),
    /** DEPRECATED (2026-06-15) — superseded by `transcripts.dir`. Honored ONLY
     *  as a fallback for `transcripts.dir` when the latter is unset. */
    transcriptDir: z.string().optional(),
  })
  .strict();

/** User-level session transcripts (2026-06-15 — see
 *  docs/specs/2026-06-15-session-transcripts-design.md). An always-on,
 *  human-readable JSONL mirror of each session's conversation, one file per
 *  session under `<dir>[/users/<owner>]/projects/<slug(cwd)>/<sessionId>.jsonl`
 *  (the Claude-Code ergonomic). The authoritative store remains `sessions.db`.
 *  All fields optional; read-site defaults: enabled=true, redactSecrets=true. */
const TranscriptsSchema = z
  .object({
    /** Write per-session transcript files. Default TRUE (like Claude Code).
     *  Set false to disable transcript writing entirely. */
    enabled: z.boolean().optional(),
    /** Base directory for transcripts; defaults to `$HARNESS_HOME`. Files live
     *  at `<dir>/projects/<slug>/<sessionId>.jsonl` (or
     *  `<dir>/users/<owner>/projects/...` for a multi-user gateway). */
    dir: z.string().optional(),
    /** Redact secrets (API keys/tokens/etc.) from each line before writing.
     *  Default TRUE — the harness writes transcripts from gateway/channel/
     *  multi-user/cron contexts, so redaction is the safe default. */
    redactSecrets: z.boolean().optional(),
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

/** Phase 1 — multi-provider task-routing config. The smart-router
 *  delegator + cost-lane sub-agents (`cheap-task`, `moderate-task`,
 *  `frontier-task`) read this block to resolve provider/model per lane.
 *  Each lane carries an optional `allowedTools` (null = inherit parent
 *  pool), `maxTokens` (null = provider default), and a positive
 *  `timeoutMs` (default 120 000). Spec:
 *  docs/specs/2026-05-23-multi-provider-task-routing-design.md */
export const LaneConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  allowedTools: z.array(z.string()).nullable().default(null),
  maxTokens: z.number().int().positive().nullable().default(null),
  timeoutMs: z.number().int().positive().default(120_000),
});

export type LaneConfig = z.infer<typeof LaneConfigSchema>;

/** Phase 1 — `taskRouting` block. `enabled: true` activates the
 *  delegator-first turn flow; defaults provide a B-via-D bridge baseline
 *  (cost-lane sub-agents available via /agent even when the router is
 *  disabled). The delegator role resolves to `delegator.model`
 *  (default `claude-sonnet-4-6`). Per-lane overrides are partial:
 *  any field omitted inherits the LANE_DEFAULTS in
 *  `src/router/lanes.ts`. */
export const TaskRoutingSchema = z.object({
  enabled: z.boolean().default(false),
  delegator: z
    .object({
      model: z.string().default('claude-sonnet-4-6'),
    })
    .default({}),
  lanes: z
    .object({
      'cheap-task': LaneConfigSchema.partial().optional(),
      'moderate-task': LaneConfigSchema.partial().optional(),
      'frontier-task': LaneConfigSchema.partial().optional(),
    })
    .default({}),
  /** Phase 2.5 — trivial-chat fast-path. When true (default false), the
   *  parent's smart-router system prompt gains an exception clause
   *  allowing it to bypass the delegator on clearly trivial turns
   *  (greetings, acknowledgments, one-liner lookup-free questions,
   *  meta-questions about the conversation). The parent answers
   *  directly in those cases, skipping the delegator + atom hops —
   *  saves ~2 model calls on conversational turns. For anything
   *  involving tools, file reads, code, or multi-step reasoning, the
   *  parent still dispatches to the delegator as before.
   *
   *  Off by default to preserve the strict "always delegate" contract
   *  Phase 1 shipped with — existing users who depend on that
   *  invariant (e.g., cost-tracking via routing-stats) are unaffected. */
  trivialFastPath: z.boolean().default(false),
  /** Phase 2.5 — user-saved lane presets. Each entry is a snapshot of
   *  `delegator.model` + `lanes.{cheap,moderate,frontier}-task.{provider,
   *  model}` under a user-chosen name. Created via
   *  `/config save-preset <name>` (snapshots current settings) and
   *  recalled via `/config apply-preset <name>` (writes the snapshot
   *  back into taskRouting.{delegator,lanes}.*).
   *
   *  Names must be lowercase letters/digits/hyphens/underscores and
   *  must not collide with a built-in preset id (see
   *  src/config/presets.ts). Validation happens at the slash dispatcher;
   *  the schema only enforces the value-shape so hand-edited config
   *  files are tolerated. */
  savedPresets: z
    .record(
      z.string(),
      z.object({
        delegator: z.object({ model: z.string() }),
        lanes: z.object({
          'cheap-task': z.object({ provider: z.string(), model: z.string() }),
          'moderate-task': z.object({ provider: z.string(), model: z.string() }),
          'frontier-task': z.object({ provider: z.string(), model: z.string() }),
        }),
      }),
    )
    .optional(),
});

export type TaskRoutingConfig = z.infer<typeof TaskRoutingSchema>;

export const SettingsSchema = z
  .object({
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    permissionMode: z.enum(['default', 'ask', 'bypass']).optional(),
    /** Reasoning-depth ("effort") default for extended thinking. `off`
     *  (the default) leaves every provider request byte-identical to a
     *  no-thinking turn; `low`/`medium`/`high`/`max` translate to the
     *  per-provider wire shapes (Anthropic `thinking.budget_tokens`,
     *  OpenAI `reasoning_effort`) at the adapter boundary, but ONLY for
     *  models that support reasoning. The `/effort` slash command mutates
     *  `runtime.effort` per session; this is the boot default it starts
     *  from. The BLOCK is optional (absent config writes nothing); when
     *  the block IS present its inner `effort` defaults to `'off'`. Every
     *  read site is defensive (`settings.thinking?.effort ?? 'off'`), so an
     *  absent block and a present `{ effort: 'off' }` are behaviorally
     *  identical. */
    thinking: z
      .object({
        effort: z.enum(REASONING_EFFORTS).default('off'),
      })
      .strict()
      .optional(),
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
        /** The keyless local Sovereign-engine lane (OpenAI-compatible MLX
         *  server on loopback). Reuses ProviderConfigSchema — only baseUrl
         *  and model are typically set; no apiKey is required. */
        sov: ProviderConfigSchema.optional(),
        /** The model-router lane (apiMode 'router'); the current binding is a
         *  self-hosted Manifest instance. Uses RouterProviderConfigSchema — the
         *  base provider config PLUS static routing-hint `headers` (Manifest
         *  custom-tier headers / x-session-key), which exist ONLY on this lane. */
        manifest: RouterProviderConfigSchema.optional(),
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
    /** Phase 1 — multi-provider task routing. `enabled: true` activates
     *  the delegator-first turn flow; defaults provide a B-via-D bridge
     *  baseline (cost-lane sub-agents available via /agent even when the
     *  router is disabled). See `TaskRoutingSchema` for shape. */
    taskRouting: TaskRoutingSchema.optional(),
    microcompaction: MicrocompactionSchema.optional(),
    compaction: CompactionSchema.optional(),
    debugMode: DebugModeSchema.optional(),
    transcripts: TranscriptsSchema.optional(),
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
        /** Learning-loop spike Task 14 — END-OF-SESSION synthesis trigger.
         *  When a session disposes with at least this many new
         *  observations/tool-iterations accrued since the last synthesis,
         *  the synthesizer fires once before the next session begins. This
         *  is what closes the N → N+1 learning loop (periodic counters
         *  rarely trip in short sessions). Honors minIntervalMs. Default 10. */
        synthesizeOnSessionEndAfter: z.number().int().positive().optional(),
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
        /** Evidence scale (τ) for the saturating confidenceFromEvidence
         *  curve used by instinct propose/update. Smaller = faster ramp.
         *  Default 13 (~6 obs clear the prune floor, ~20 the promotion
         *  gate at cap 0.9). */
        evidenceSaturation: z.number().positive().optional(),
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
        /** Learning-loop spike Phase 1 — per-turn recall. When enabled,
         *  the host builds a per-session recall thunk (sessionContext) that
         *  splices recalled instinct lessons in front of the latest user
         *  turn (query() does the splice). ON by default as of v0.6.16
         *  (founder decision 2026-06-04, after the spike's Q1 cleared its
         *  bar). It stays fail-open and is a no-op when the instinct corpus
         *  is empty; it is wired on the turns route only (TUI/server/`sov
         *  drive`). Opt out with `learning.recall.enabled: false`.
         *  `maxLessons` caps how many lessons are surfaced; `tokenBudget`
         *  caps the injected snapshot size. */
        recall: z
          .object({
            enabled: z.boolean().default(true),
            maxLessons: z.number().int().positive().default(8),
            tokenBudget: z.number().int().positive().default(1200),
          })
          .strict()
          .optional(),
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
    /** Phase 18 — OpenAI-compatible HTTP API server. When `sov serve`
     *  boots, it reads this block to resolve the API key (header bearer
     *  token), the bind port, and the bind host. All fields optional;
     *  defaults documented at the call site (host defaults to 127.0.0.1).
     *  The API key MUST be present at startup or `sov serve` errors out
     *  before binding the socket. */
    openaiServer: z
      .object({
        apiKey: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        host: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Phase A — long-lived `sov gateway` exposing the native HTTP+SSE
     *  protocol off-loopback. `host` defaults to loopback (127.0.0.1);
     *  `token` is the bearer token clients must present and is REQUIRED
     *  whenever the gateway is exposed off-loopback; `corsOrigins` is the
     *  allow-list of browser origins for cross-origin clients. All fields
     *  optional; defaults documented at the call site. */
    gateway: z
      .object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        token: z.string().min(1).optional(),
        corsOrigins: z.array(z.string()).optional(),
        /** Phase B — bound on each per-session SSE replay ring. Buses
         *  created at runtime use this size (set once at boot via
         *  setDefaultRingSize); larger values keep more events available
         *  for Last-Event-ID reconnect / fresh-subscriber replay at the
         *  cost of memory. Defaults to DEFAULT_MAX_RING (512) when unset. */
        eventBufferSize: z.number().int().positive().optional(),
        /** Phase D — SessionSupervisor idle-session lifecycle policy for a
         *  long-lived gateway. `idleSessionTimeoutMs` is the window an
         *  untouched (no live subscriber, no in-flight turn) session may sit
         *  before its in-memory state is reclaimed; `idleSweepIntervalMs` is
         *  the background sweep cadence. Both are positive-int milliseconds;
         *  the supervisor applies its own defaults (30 min / 5 min) when
         *  unset. `maxConcurrentSessions` caps live in-memory sessions — 0
         *  means unlimited — enforced by POST /sessions (429 once at the
         *  ceiling). All three optional + gateway-scoped. */
        idleSessionTimeoutMs: z.number().int().positive().optional(),
        idleSweepIntervalMs: z.number().int().positive().optional(),
        maxConcurrentSessions: z.number().int().nonnegative().optional(),
        /** Phase E — multi-user principals registry. Each principal has a
         *  filesystem-safe `id` (^[A-Za-z0-9_-]+$, unique), a non-empty bearer
         *  `token` (unique), and an optional display `name`. Mutually exclusive
         *  with the single-token `token` field above — a gateway runs one auth
         *  model at a time. The id is security-load-bearing (it becomes a path
         *  segment for per-principal isolation); the cross-field rules are
         *  enforced by the superRefine below. */
        principals: z
          .array(
            z.object({
              id: z.string(),
              token: z.string().min(1),
              name: z.string().optional(),
            }),
          )
          .optional(),
        /** Phase F — inbound channels (webhook / telegram / slack) that drive
         *  harness turns. Each ENABLED channel binds to a Phase-E principal via
         *  `principalId` (∈ gateway.principals) so it is isolated to one
         *  principal, and carries its required secret(s). `permissionMode`
         *  EXCLUDES 'bypass' by construction — a remotely-reachable channel
         *  running with permissions bypassed is an RCE — so bypass is a parse
         *  error, not a refine. Secret-vs-env: this schema requires the secret
         *  field present in CONFIG; boot-time env resolution is handled in F-T7
         *  by injecting env into the config object BEFORE parse (keeping this
         *  schema pure / env-free). The enabled-channel cross-field rules
         *  (principalId ∈ principals; required secrets) are in the superRefine. */
        channels: z
          .object({
            webhook: z
              .object({
                enabled: z.boolean().optional(),
                secret: z.string().optional(),
                principalId: z.string(),
                permissionMode: z.enum(['default', 'ask']).optional(),
              })
              .strict()
              .optional(),
            telegram: z
              .object({
                enabled: z.boolean().optional(),
                botToken: z.string().optional(),
                principalId: z.string(),
                permissionMode: z.enum(['default', 'ask']).optional(),
              })
              .strict()
              .optional(),
            slack: z
              .object({
                enabled: z.boolean().optional(),
                signingSecret: z.string().optional(),
                botToken: z.string().optional(),
                principalId: z.string(),
                permissionMode: z.enum(['default', 'ask']).optional(),
              })
              .strict()
              .optional(),
            /** SMS (Twilio). UNLIKE the other channels, SMS binds the SENDER to
             *  a principal via a `senders` ALLOW-LIST (a phone number is publicly
             *  textable; the Twilio signature authenticates the TRANSPORT, not the
             *  sender). `provider` is the literal 'twilio' (v1) — the extensibility
             *  seam for other SMS providers. The Twilio creds (accountSid/authToken/
             *  fromNumber) are secrets, env-resolvable before parse (like the other
             *  channels). The enabled-channel cross-field rules (non-empty senders;
             *  every senders value ∈ principals; the three creds present) are in the
             *  superRefine. permissionMode EXCLUDES 'bypass' by construction. */
            sms: z
              .object({
                enabled: z.boolean().optional(),
                provider: z.literal('twilio'),
                accountSid: z.string().optional(),
                authToken: z.string().optional(),
                fromNumber: z.string().optional(),
                senders: z.record(z.string(), z.string()).default({}),
                helpText: z.string().optional(),
                permissionMode: z.enum(['default', 'ask']).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((gw, ctx) => {
        const { principals, token, channels } = gw;
        if (principals !== undefined) {
          // Fix E2 — an explicitly-present-but-empty registry is almost
          // certainly a half-finished config (operator meant to add entries).
          // Left as `[]` it silently degrades to single-user/open on loopback,
          // so reject it with an actionable message instead.
          if (principals.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'gateway.principals must not be empty when set',
              path: ['principals'],
            });
          }
          // (a) single-token and per-principal auth are mutually exclusive.
          if (token !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'gateway.principals and gateway.token are mutually exclusive',
              path: ['principals'],
            });
          }
          const seenIds = new Set<string>();
          const seenTokens = new Set<string>();
          const idRe = /^[A-Za-z0-9_-]+$/;
          principals.forEach((p, i) => {
            // (d) each id must be a filesystem-safe segment.
            if (!idRe.test(p.id)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `gateway.principals[${i}].id ${JSON.stringify(p.id)} must match ${idRe}`,
                path: ['principals', i, 'id'],
              });
            }
            // (b) ids unique.
            if (seenIds.has(p.id)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `gateway.principals[${i}].id ${JSON.stringify(p.id)} is duplicated`,
                path: ['principals', i, 'id'],
              });
            }
            seenIds.add(p.id);
            // (c) tokens unique.
            if (seenTokens.has(p.token)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `gateway.principals[${i}].token is duplicated`,
                path: ['principals', i, 'token'],
              });
            }
            seenTokens.add(p.token);
          });
        }
        // Phase F — validate ENABLED channels only. (a) principalId must resolve
        // to a declared principal (channels are per-principal-isolated; this also
        // fails when principals is absent entirely). (b) the channel's required
        // secret(s) must be present in config (env injection happens in F-T7
        // before parse, so an env-sourced secret merged in passes here). Disabled
        // / enabled-omitted channels are not validated. ('bypass' is already
        // impossible — permissionMode's enum is ['default','ask'].)
        if (channels !== undefined) {
          const principalIds = new Set((principals ?? []).map((p) => p.id));
          const requireSecret = (
            name: 'webhook' | 'telegram' | 'slack' | 'sms',
            field: string,
            value: string | undefined,
          ): void => {
            if (value === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `gateway.channels.${name} is enabled but ${field} is missing`,
                path: ['channels', name, field],
              });
            }
          };
          const requirePrincipal = (
            name: 'webhook' | 'telegram' | 'slack',
            principalId: string,
          ): void => {
            if (!principalIds.has(principalId)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `gateway.channels.${name}.principalId ${JSON.stringify(principalId)} is not a declared gateway.principals id`,
                path: ['channels', name, 'principalId'],
              });
            }
          };
          const { webhook, telegram, slack, sms } = channels;
          if (webhook?.enabled === true) {
            requirePrincipal('webhook', webhook.principalId);
            requireSecret('webhook', 'secret', webhook.secret);
          }
          if (telegram?.enabled === true) {
            requirePrincipal('telegram', telegram.principalId);
            requireSecret('telegram', 'botToken', telegram.botToken);
          }
          if (slack?.enabled === true) {
            requirePrincipal('slack', slack.principalId);
            requireSecret('slack', 'signingSecret', slack.signingSecret);
            requireSecret('slack', 'botToken', slack.botToken);
          }
          // SMS — the SENDER allow-list is the security gate (D4). An enabled sms
          // channel must (a) carry the three Twilio creds, (b) have a NON-EMPTY
          // `senders` map, and (c) every senders VALUE (a principalId) must resolve
          // to a declared principal — an unlisted/ghost mapping would let a sender
          // drive a turn under a non-existent principal. (`provider` is the literal
          // 'twilio' at the type level; 'bypass' is already impossible.)
          if (sms?.enabled === true) {
            requireSecret('sms', 'accountSid', sms.accountSid);
            requireSecret('sms', 'authToken', sms.authToken);
            requireSecret('sms', 'fromNumber', sms.fromNumber);
            const senderEntries = Object.entries(sms.senders);
            if (senderEntries.length === 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  'gateway.channels.sms is enabled but senders is empty — an SMS number is publicly textable, so at least one sender→principal mapping is required',
                path: ['channels', 'sms', 'senders'],
              });
            }
            for (const [number, principalId] of senderEntries) {
              if (!principalIds.has(principalId)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `gateway.channels.sms.senders[${JSON.stringify(number)}] ${JSON.stringify(principalId)} is not a declared gateway.principals id`,
                  path: ['channels', 'sms', 'senders', number],
                });
              }
            }
          }
        }
      })
      .optional(),
    /** SPIKE (off by default) — opt-in headless Claude Code sub-agent
     *  executor. When `enabled: true`, a delegation to the
     *  `subscription-executor` role hands the task to a spawned `claude -p`
     *  subprocess that runs its OWN agentic loop and returns a summary,
     *  round-tripping through the unchanged scheduler tail. Absent block =
     *  today's behavior (the lane is unavailable + the scheduler branch is
     *  inert). Personal/attended/dogfood use only — see the spike doc at
     *  docs/specs/2026-06-08-subscription-executor-spike.md for the ToS
     *  boundary (the official binary on your own subscription is the only
     *  defensible mode; automated/multi-tenant/unattended use stays on the
     *  per-token API).
     *
     *  `permissionMode` chooses the spawned subprocess's posture and DEFAULTS
     *  to `bypass` (→ `--dangerously-skip-permissions`): a headless `claude -p`
     *  has no interactive approver, so the safe modes stall real work. This is
     *  acceptable ONLY because the executor is reachable solely from the
     *  interactive sub-agent seam (NOT cron/channels/gateway) — the operator is
     *  attended, delegating to their own logged-in Claude Code. `plan` |
     *  `acceptEdits` | `default` are the safer opt-in alternatives. The remote
     *  channel surfaces keep their own bypass rejection (src/channels/permission.ts). */
    subscriptionExecutor: z
      .object({
        enabled: z.boolean().optional(),
        engine: z.enum(['claude-code']).optional(),
        binary: z.string().optional(),
        permissionMode: z.enum(['plan', 'acceptEdits', 'default', 'bypass']).optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxTurns: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** Conduct Port binding (spec D30) — an OPTIONAL decorum conduct/persona
     *  pack the `sov gateway` loads at boot and enforces via the Conduct Port.
     *  `configPath` is a deployment-binding `conduct.yaml`; `packDir` is a
     *  directory holding one (used only when `configPath` is unset —
     *  `<packDir>/conduct.yaml`). ABSENT block = today's behavior EXACTLY: no
     *  provider is constructed and every seam runs as the null provider
     *  (byte-identical). When the block IS present the gateway builds the
     *  decorum adapter and FAILS CLOSED at boot on a missing/invalid pack —
     *  it never boots into a no-governance state. Both fields optional at the
     *  schema layer; the adapter throws if neither is supplied. */
    conduct: z
      .object({
        configPath: z.string().min(1).optional(),
        packDir: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Observability & audit logging. Sibling to `conduct` — governs how
     *  governance/observability signals surface in the per-session trace.
     *  Absent block ⇒ every field takes its default. */
    observability: z
      .object({
        /** Record conduct/governance audit events to the per-session trace
         *  log. Content-free, so on by default whenever a conduct pack is
         *  active. Set false to suppress the audit trail. */
        conductAudit: z.boolean().default(true),
      })
      .strict()
      .optional(),
    /** Plugin System v1 — OPT-IN enable/disable allow-list for installed
     *  plugins (under `<harnessHome>/plugins/*`). Both lists hold plugin names
     *  (manifest `name`). The T3 loader consults this block: when `enabled` is
     *  SET, only listed plugins are enabled (a consented-but-unlisted plugin is
     *  inert); a name in `disabled` is always off (disabled wins when a name
     *  appears in both). Absent block / absent `enabled` ⇒ every consented,
     *  untampered plugin is active by default. The block carries NO secrets and
     *  never names a path — only opt-in identity decisions. */
    plugins: z
      .object({
        enabled: z.array(z.string()).optional(),
        disabled: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  // subscriptionExecutor and taskRouting are two CONFLICTING cost strategies on
  // the SAME sub-agent delegation path, so enabling both is incoherent:
  //   - taskRouting forces parent → delegator → API cost-lane sub-agents
  //     (cheap/moderate/frontier on the per-token API);
  //   - subscriptionExecutor offloads delegated tasks to a flat-rate `claude -p`
  //     subscription subprocess.
  // The delegator can't even reach the subscription-executor role, and the ToS
  // postures are opposite (per-token API vs. attended personal subscription).
  // Reject the combination at parse time with an actionable message. (The
  // future "subscription-as-a-routing-lane" compose is out of scope — see
  // docs/specs/2026-06-08-subscription-executor-spike.md.)
  .superRefine((settings, ctx) => {
    if (settings.subscriptionExecutor?.enabled === true && settings.taskRouting?.enabled === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          '`subscriptionExecutor` and `taskRouting` are mutually exclusive — they are two different cost strategies (a flat-rate subscription vs. API cost-tier routing); enable only one.',
        path: ['subscriptionExecutor', 'enabled'],
      });
    }
  });

export type Settings = z.infer<typeof SettingsSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type SubscriptionExecutorConfig = NonNullable<Settings['subscriptionExecutor']>;
export type PluginsConfig = NonNullable<Settings['plugins']>;
export type TranscriptsConfig = NonNullable<Settings['transcripts']>;

/** Resolved transcripts config with read-site defaults applied (the schema is
 *  `.optional()` per the project convention, so absent-parent → defaults).
 *  `enabled` and `redactSecrets` default TRUE (always-on, like Claude Code);
 *  the legacy `debugMode.transcriptDir` is honored only as a fallback for
 *  `dir`. */
export function resolveTranscriptsConfig(settings: Settings): {
  enabled: boolean;
  redactSecrets: boolean;
  dir?: string;
} {
  const t = settings.transcripts;
  const dir = t?.dir ?? settings.debugMode?.transcriptDir;
  return {
    enabled: t?.enabled ?? true,
    redactSecrets: t?.redactSecrets ?? true,
    ...(dir !== undefined ? { dir } : {}),
  };
}
