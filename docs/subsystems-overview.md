# The Sovereign AI Harness — Subsystems Atlas

**A plain-language map of everything the harness is made of, down to the individual component.** This is an atlas for human readers: it names each major region, the subsystems inside it, and the individual pieces inside those — describing *what* each does and *why* it's there, never *how* it's coded. For the technical walkthrough see [`architecture.md`](architecture.md); for hands-on use see [`usage.md`](usage.md).

*Compiled 2026-06-09 from a complete sweep of the codebase. Scale: ~56,000 lines of TypeScript across ~36 runtime subsystems, a separate Go terminal-UI program, a default "harness bundle," and ~3,600 tests. This version enumerates every individual component — the leaf level. (Pure wiring and type-definition files are folded in rather than listed, since they aren't things the harness is "composed of" so much as glue between them.)*

---

## What it is, in one breath

A **coding-agent runtime** in the Claude Code mold. It reads a *bundle* of instructions and context as data, wraps a conversation around it, streams a language model, lets that model use tools, learns from what happens, and remembers the session. Two programs cooperate — a **runtime + server** (the brain) and a **terminal UI** (the face) — over a local connection that also powers a headless mode, a secure remote server, a standard API, and inbound chat channels.

**The seventeen regions:**

> **1** Core engine · **2** Providers · **3** Tools & permissions · **4** Sub-agents & routing · **5** Learning · **6** Persistence · **7** Configuration · **8** Extension surfaces · **9** Observability · **10** Run-anywhere surfaces · **11** Channels · **12** Scheduling · **13** Terminal UI · **14** Command line · **15** Distribution · **16** Testing · **17** Foundations

---

## 1. The Core Engine — the conversation loop

The center of gravity: take a message, run the model, use tools, repeat.

- **The turn loop** — the engine of a single exchange; streams the model and keeps going as long as it reaches for tools.
- **The tool dispatcher** — runs the tools the model asks for: checks each is allowed, runs independent ones together, stops file-clashing ones from colliding, returns results in order.
- **The internal message format** — one common shape for text, the model's private "thinking," tool requests, tool results, and images, so the rest of the system never sees a vendor's raw format.
- **Recall injection** — the exact spot where learned lessons get slipped into a message, just before the model runs.
- **Transcript repair** — heals a broken conversation (e.g. a tool request with no matching result) before it can confuse the model.
- **Token estimation** — a fast ruler for "how much of the model's memory are we using."
- **The system-prompt & context builder** — assembles the standing instructions, frozen once per session:
  - **The prompt assembler** — stitches together base instructions, the tool summary, the skills index, bundle content, memory, and runtime facts.
  - **The "how this harness works" briefing** — a vendor-neutral explainer of the harness's own rules that travels inside the prompt.
  - **@-reference expansion** — pulls a named file, folder, diff, or web page into a message, fetched and trimmed beforehand.
  - **Subdirectory hints** — surfaces nearby project-instruction files just-in-time as the agent moves between folders.
  - **Prompt-injection defense** — screens local context files for instruction-hijacking; suspicious files become blocked placeholders.
  - **Local project context** — folds in a project's own instruction and editor-rule files.
  - **Context-budget audit** — adds up how much memory each ingredient eats and flags the bloated ones.
- **Loop detection** — spots a stuck, repeating agent; nudges first, then stops the runaway.
- **Compaction** — keeps long conversations from overflowing:
  - **Micro-compaction** — silently clears stale tool output once it dominates memory; no extra model call; reversible.
  - **Full / proactive compaction** — when the window truly fills, summarizes older history into a smaller fresh session.

## 2. The Provider Layer — many models, one socket

One uniform connector to every model vendor.

- **Anthropic connector** — talks to Claude models.
- **OpenAI connector** — talks to OpenAI (and OpenAI-compatible) models.
- **Ollama connector** — talks to locally-run open models.
- **`sov` connector** — talks to your own private inference engine, with no API key needed.
- **OpenRouter** — reaches many models through one gateway (via the OpenAI connector).
- **Mock model** — a scripted stand-in used by the test suite.
- **Auxiliary connector** — handles small side calls.
- **Model registry** — the catalog of known models and their memory sizes.
- **Pricing** — the cost-per-token tables behind spend tracking.
- **Resolver** — wires up the right connector, model, and credentials from a name.
- **Credential pool** — manages API keys.
- **Rate guard** — backs off politely when a provider says "slow down."
- **Preflight** — verifies credentials before a session starts, so failures surface early.
- **Reasoning effort** — the off/low/medium/high/max dial for how hard the model thinks, translated to each vendor's mechanism and ignored on models that can't reason.
- **Error normalizer** — turns each vendor's idiosyncratic failures into one common, classified error.
- **The local-vs-frontier router** — an optional switch that picks a cheap local or powerful frontier model per turn:
  - **The classifier** — the rule set that makes the call.
  - **The audit log** — an append-only record of every routing decision and why.

## 3. Tools & Permissions — what the agent can do, and what it's allowed to do

Everything the agent acts with flows through one common tool shape, safe by default.

- **The native toolbox:**
  - **Read a file** · **Write a file** · **Edit a file** · **Find files by name** · **Search file contents** — the file-handling core.
  - **Run a shell command** — the workhorse, with a recovery hint attached on every failure.
  - **Fetch a web page** · **Search the web** — open-web reach (search hides itself when no key is set).
  - **Run a skill** · **List skills** · **View a skill** · **Manage skills** — the reusable-playbook tools.
  - **Read/update memory** · **Propose a memory change** · **Propose a new skill** — the durable-knowledge tools.
  - **List / view / propose / re-score instincts** — the learned-lesson tools.
  - **Create / list / check / read / stop a background task** — the long-job tools.
  - **Delegate to a sub-agent** — hand a sub-task to a specialist.
  - **Ask the harness about itself** — answer "what am I running, with which tools and settings?"
  - **Look up a tool's details** — fetch a tool's full description only when needed, to save space.
  - **Validate a static website** — checks a generated site (used by the website-building evaluation).
- **The result envelope** — an optional status + summary + "what to try next" attached to a tool's output; most valuable as a recovery hint on errors.
- **Permissions:**
  - **The rule engine** — layered allow/deny/ask rules (project → user → global), deny always wins.
  - **Input rewriting** — a permission decision can clean up or narrow a tool's input first.
  - **The approval prompt** — how an "ask" decision reaches a person for a yes/no.
  - **Shell understanding** — reads a shell command well enough to treat a read-only `cat` as just "read," so harmless commands don't nag.
  - **Secret scrubbing** — two layers: a scanner that recognizes credential shapes, and a rewriter that masks them in anything written to disk.
- **Sudo guardrail** — refuses password-requiring commands that would just hang.
- **The `!` escape hatch** — lets a person run such commands themselves, with their own terminal.

## 4. Sub-Agents, Routing & Background Work — putting a team to work

The agent can spin up specialists and split work across cheaper and pricier models.

- **Sub-agent definitions** — the roster of specialists and how they're loaded:
  - **The loader** — finds agent definitions in the project, the user folder, or the bundle.
  - **The exclusion list** — the tools no sub-agent is ever handed (to prevent runaway spawning).
  - **The reference roster** — a read-only **explorer**, a claim **verifier**, a **planner**, the learning **reviewers**, the instinct **synthesizer**, the routing lanes (cheap / moderate / frontier / delegator), a **scheduled-mission** runner, and the **subscription-executor**.
- **The scheduler** — the team manager: caps concurrent helpers, prevents write clashes, picks each helper's model, enforces timeouts, records lineage, and fires the learning hook when a helper finishes.
- **Concurrency limiters** — the counters that cap how many helpers (and how many per cost lane) run at once.
- **The runner** — the shared plumbing that actually drives a sub-agent (reused by cron, channels, and the API).
- **The delegation tool's wiring** — closes the list of valid specialists to exactly those loaded, and hides delegation entirely when none are.
- **Task routing:**
  - **The cost lanes** — cheap / moderate / frontier tiers, each possibly on a different model.
  - **The lane registry** — pre-resolves each lane to a concrete model.
  - **The capability profiles** — per-model notes (memory size, cost tier, reliability) used to match a job to a model.
  - **Progress reporting** — the live "dispatching atom 3 of 5" signals.
  - **Routing stats** — the data behind the `/routing-stats` report.
  - **Lane preflight** — checks every configured lane's credentials up front.
- **The subscription executor** — an experimental option to hand a sub-task to a local Claude Code install instead, reusing its loop; limited to attended personal use for licensing reasons.
- **The background task system:**
  - **The task manager** — creates, tracks, and cancels long jobs.
  - **The task store** — where those jobs and their output live.

## 5. The Learning System — getting better at a project over time

The most ambitious horizontal feature: watch, distill, and feed lessons back — behind a review gate.

- **The capture pipeline:**
  - **The observer** — quietly records every tool call into a per-project notebook, never slowing the conversation.
  - **Project identity** — a stable fingerprint for "which project is this."
  - **Cluster keying** — groups similar moments together (ignoring incidental differences like exact paths or numbers).
  - **The synthesizer** — reads the notebook and proposes compact, confidence-weighted "instincts."
  - **Confidence math** — how an instinct strengthens with repetition, drops when contradicted, and is pruned if it stays weak.
  - **Confidence tuning** — the bridge that lets settings adjust that math.
  - **The instinct store** — where instincts live on disk, one tidy file each.
  - **Cross-project promotion** — graduates a lesson to "global" once it recurs across two or more projects with high confidence.
- **The portable learning layer** — the whole concern sealed behind four clean ports so the engine can be swapped or rented later:
  - **The four ports** — Observe (watch), Recall (surface), Reason (think), Persist (store).
  - **Recall assembly** — gathers the most relevant lessons within a memory budget.
  - **Recall formatting** — packages them into a tidy "here's what you've learned" note.
  - **Instinct reading** — the shared way both the layer and the store read lessons.
  - **The harness bindings** — the one set of host-specific adapters (storage + a model-backed reasoner).
  - **The evaluation harness** — measures, with-vs-without, whether recall actually flips the agent's answers for the better.
- **Recall — the closed loop** — slips the lesson note into each turn; on by default, harmless when there's nothing to recall.
- **The review pipeline:**
  - **The review manager** — periodically pauses to ask "what did we learn?" and dispatches a reviewer.
  - **The review fork** — sets up the restricted reviewer session with only the proposal tools.
  - **Proposals** — drafted changes to memory or skills, parked in a pending tray with full provenance.
  - **Consolidation** — merges overlapping proposals into one clean entry.
  - **Stall detection** — bails out of a reviewer that's spinning its wheels.
  - **The `/review` controls** — list, show, approve, reject, consolidate, and activity.
- **Memory:**
  - **The bounded store** — a small, durable notebook of facts about the user and project.
  - **Injection** — slips that notebook into each turn (the same channel recall uses).
  - **Scoping** — keeps each user's and project's memory separate.

## 6. Persistence & State — what's remembered

- **The session database** — the local store of every session: messages, frozen instructions, token usage, costs, and the family tree of compactions and sub-agents.
- **Session recovery** — repairs and restores a session after escape hatches like `/clear`.
- **Profiles:**
  - **Path resolution** — the single source of truth for "where does this user's data live."
  - **The profile lock** — stops two sessions from stomping on the same profile.
  - **Profile commands** — create, list, switch, and seed separate "worlds" for different projects.
- **The state layout** — the tidy home folder where sessions, memory, settings, credentials, traces, lessons, and agent-made skills all live.

## 7. Configuration — the knobs, with two front doors

- **The settings schema** — the master list of every adjustable setting and its valid range.
- **The catalog** — the curated, grouped menu that powers both front doors so they always agree.
- **Live-apply** — lets select settings take effect mid-session without a restart.
- **Presets** — one-tap configurations (e.g. "run cheap things locally, escalate the rest").
- **The draft manager** — safe in-progress editing of settings.
- **The store & loader** — reads and writes settings across the project/user/global layers.
- **Rules** — the small helpers that interpret and validate setting values.

## 8. Extension Surfaces — how the harness grows

- **Skills:**
  - **The loader & format reader** — discovers plain-markdown playbooks from project, user, or bundle and reads their front-matter.
  - **The command builder** — turns skills into slash commands.
  - **Visibility gates** — hide a skill when its tools aren't active.
  - **The "when to use" heuristic** — helps the model judge whether a skill applies.
  - **The guard scanner & symlink guard** — block risky third-party skill content and sneaky file links before they're trusted.
  - **Install** — adds an agent-created skill safely.
- **Hooks:**
  - **The runner** — runs your own scripts at four moments (before/after a tool, on a new prompt, at session end).
  - **The matcher** — decides which hook fires for which tool.
  - **Consent** — the one-time allow/deny gate before any hook can run.
  - **Safe argument splitting** — runs hooks without shell-string risks.
- **MCP (external tool servers):**
  - **The client** — connects to external tool servers over several transport types.
  - **The tool wrapper** — folds their tools into the native toolbox.
  - **Remote auth** — supplies their credentials safely, never logged.
  - **Safe fetch** — blocks a server from being tricked into reaching internal addresses.
  - **Schema handling** — defers their detailed tool descriptions until needed, to save space.
- **Plugins:**
  - **The manifest reader** — validates a plugin's declaration.
  - **The consent + integrity gate** — re-checks a content fingerprint every startup; an edited or unconsented plugin goes inert.
  - **The composer** — splices a plugin's skills and commands into the right precedence.
  - **Install / uninstall** — adds a plugin only from the local terminal, after a plain-language disclosure.
  - **The disclosure builder** — writes the "here's what this plugin adds" summary.
  - **The safety scanners** — a secret scan, a path-containment check, and a snapshot for listing.
- **The bundle system:**
  - **The bundle loader** — reads a bundle (business content, schemas, skills, agents, prompts, working state) as data.
  - **The default-bundle resolver** — falls back to a shipped, vendor-neutral bundle when none is present.
  - **Bundle initialization** — the command that graduates a folder into a real bundle.

## 9. Observability — seeing what happened

- **Operational traces:**
  - **The trace writer** — a per-session flight recorder of turns, model round-trips with timing, tool calls, and permission checks; also hardened so a malicious filename can't escape its folder.
  - **The trace viewer** — renders that recording into a readable per-turn summary.
- **Trajectory capture:**
  - **The writer** — saves conversations in a standard training-data format, split into successes and failures.
  - **The format mapper** — converts the internal conversation into that standard shape.
  - **Secret redaction** — scrubs credentials out before anything touches disk.

## 10. Run-Anywhere Surfaces — local terminal to secure server

One shared connection protocol, plus the program that grew the harness into a secure, multi-user service.

- **The session protocol:**
  - **The event bus** — fans a session's live events out to many watchers, with a replay buffer for clean reconnects.
  - **The event stream encoder** — formats those events for the wire.
  - **The session routes** — the individual endpoints: start/list/delete a **session**, send a **turn**, watch **events**, answer an **approval**, **cancel** a turn, **compact**, run a **command**, list **skills**, receive a **channel** message, a **health** check, and an **ownership** guard.
  - **The session & command context** — assembles everything one session needs (its memory, learning, tools, commands) per request.
- **The secure gateway:**
  - **The gateway command** — the long-lived server that exposes the rich experience beyond the local machine.
  - **Bearer auth** — the login-token check on every request.
  - **Cross-origin rules** — controls which web origins may connect.
  - **The safety guard** — refuses to start if it would be exposed without protection.
- **The reference web UI** — a complete, self-contained browser chat client embedded in the program (streaming, thinking, tool cards, inline approve/deny, reconnect).
- **The persistent supervisor** — lets one server hold many sessions across clients and restarts; evicts idle ones and rebuilds them from disk on demand.
- **Multi-user identity:**
  - **Principals** — named users, each with their own login token.
  - **Session ownership** — the guard that hides one user's sessions from another.
- **The approval queue** — routes a "may I run this?" prompt to whichever client is watching and waits.
- **The OpenAI-compatible API:**
  - **The server & app** — a standard endpoint that works with off-the-shelf OpenAI client libraries.
  - **Model resolution** — maps a requested model name to a real one.
  - **The message & response mappers** — translate between the OpenAI format and the harness's internal one.
  - **The streaming translator** — emits OpenAI-shaped streaming chunks while running the tool loop internally.

## 11. Channels — letting the outside world start a conversation

A framework that turns an inbound message into an isolated, safe-by-default session and replies.

- **The pipeline** — the shared core: a continuous conversation per sender, one turn under a deliberately strict safety posture, then the reply.
- **The safety posture** — never inherits local permissions, never auto-approves risky actions, rejects "bypass."
- **History seeding & delivery** — rehydrates a returning conversation and sends the outgoing reply.
- **The listeners** — start and stop the poll-based channels.
- **The adapters:**
  - **Slack** — events API with signature checks and fast-ack-then-reply.
  - **Telegram** — polls for updates, no public endpoint needed.
  - **Generic webhook** — a signed endpoint for anything custom.
  - **SMS (Twilio)** — signature + per-sender allow-list, async reply, and carrier STOP/HELP handling.

> **About "Stripe":** there is **no Stripe or payments integration** in this harness. Stripe shows up only incidentally — as an example vendor name in the security-audit skill, and as one of the credential *patterns* the secret-scrubber recognizes so it can mask keys. The real outside-world integrations are the four channels above.

## 12. Scheduling & Automation — work that runs on its own

- **Cron / scheduled jobs:**
  - **The schedule parser** — understands relative, interval, cron-expression, and exact-time schedules.
  - **The job store** — the saved list of jobs.
  - **The runner & executor** — fires due jobs in fresh headless sessions, optionally chaining a skill or setup script, delivering output to an outbox.
  - **The lock** — keeps two processes from double-firing the same job.
- **Missions:**
  - **The mission state machine** — drives a longer autonomous run through defined stages.
  - **Segments & state** — the steps of a mission and its saved progress.
- **The daemon** — an earlier single-machine background host (with its own session cache, event bus, and approval queue); the persistent-host role was ultimately filled by the gateway, so this remains a secondary entry point.

## 13. The Terminal UI — the face of the harness

A separate, polished terminal program (in Go) that renders the live conversation.

- **The app core:**
  - **The controller** — the central loop that ties everything together.
  - **Keyboard handling** — what each keypress does.
  - **The slash-command router** — sends `/`-commands to the right place.
  - **The expand feature** — re-show the last tool output in full.
  - **Theme config** — applies the chosen look.
- **The on-screen pieces:**
  - **The live region** — the bottom area holding the streaming answer, spinner, and running-command note.
  - **Tool cards** (and a **compact one-line** variant) — how a tool's action and result are shown.
  - **The compaction card** — the "history was summarized" marker.
  - **The delegation/routing line** — shows sub-agent and cost-lane activity.
  - **The picker menu** — the inline chooser used by model / theme / effort / resume / export.
  - **The permission prompt** — the inline approve/deny card.
  - **The prompt box** — the multi-line input area.
  - **The slash autocomplete** — the command suggestions popup.
  - **The status line** — the bottom strip (folder · profile · model · cost · memory).
  - **The spinner**, the **splash** screen, the **"stalled?" badge**, the **input card**, **notifications**, and the **goodbye** summary.
- **The render helpers** — formatters for markdown, code highlighting, diffs, and plain text.
- **The style system** — one shared vocabulary for every spacing, color, and glyph.
- **Themes** — built-in Dark, Light, Tokyo Night, and Sovereign looks, plus a loader for user-supplied themes.
- **The transport decoders** — turn the server's live event stream (events, commands, pickers, skills, input) into screen updates.
- **The runtime-side render helpers** — a parallel set on the brain's side, used by the headless and other non-terminal surfaces:
  - **The context meter** — a live "how full is the model's memory" gauge.
  - **The session-summary card** — the end-of-session report (tool counts, success rate, timing).
  - **Diff, box, splash, footer, modal, autocomplete, input-history, and text-buffer** helpers — the building blocks for rendering output outside the Go UI.

## 14. The Command Line — every way to launch it

A single entry point exposes the full subcommand set:

- **The default app** — boots the brain and opens the terminal UI.
- **drive** — headless, line-by-line conversation (for scripts and tests).
- **serve** — the standard OpenAI-compatible API.
- **gateway** — the secure remote server.
- **cron**, **mission**, **daemon** — automation hosts.
- **config**, **profile** — settings and separate worlds.
- **learning** (status / prune / export) — inspect and tend the learned corpus.
- **eval**, **trace** — run golden tests and inspect session recordings.
- **init** — turn a folder into a bundle.
- **dispatch** — run a single slash command headlessly.
- **upgrade** — keep the install current.

## 15. Distribution & Release — getting it onto machines

- **Binary distribution** — self-contained, per-platform builds (brain + terminal UI + default bundle) published to a public releases repo with a one-line installer.
- **Self-upgrade** — one command that detects the install type and updates the right way.
- **Release automation** — a version tag triggers an automated cross-platform build-and-publish; the convention is to cut a release in any session that changes behavior.

## 16. Testing & Evaluation — keeping it honest

- **Unit & integration tests** — thousands of fast checks; the standing gate is "lint, type-check, and test all pass."
- **The semantic suite** — drives the real program as a subprocess and has a language-model judge score the transcript against per-test criteria, with swappable judges (a sandbox builder, a driver, the judges, and a runner).
- **The eval suite** — declarative "golden tasks" (a seeded sandbox, a prompt, pass/fail assertions) with an optional spend budget.
- **Record & replay** — captures a live run and replays it deterministically (a capturer, a loader, a replay model, and a replay toolset).
- **The website-build evaluation** — an end-to-end check of generating a static site.
- **Visual UI QA** — a screenshot harness that renders the terminal UI to images for review.

## 17. Foundations — the bedrock beneath it all

- **Nine locked design principles** — settled decisions that aren't re-litigated.
- **A standing set of invariants** — load-bearing rules upheld everywhere (the conversation engine's shape never changes underneath callers; the system prompt is frozen per session; external tools obey the same safety pipe as built-ins; cleanup never aborts on one failure; secret-scrubbing can't be switched off mid-session).
- **Vendor-neutral by construction** — nothing product-specific is baked into the runtime, so the same engine can be white-labeled; the business identity lives in a separate documentation repo.
- **The documentation map** — deeper docs for the runtime flow, daily operation, extension recipes, testing, and design principles, plus a running log of state snapshots, specs, plans, conventions, and postmortems.

---

*This atlas is the complete map at the component level. Each leaf has its own implementation, deeper doc, and tests — but as a picture of **what the harness is composed of**, this is the whole of it. To go further is to read the code itself.*
