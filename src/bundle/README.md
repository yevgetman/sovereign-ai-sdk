# Bundle-as-data contract

A "harness bundle" is a directory with the three-tier shape:

```
<bundle>/
├── business/         tier 1 — authoritative business data (read-only to runtime)
├── harness/          tier 2 — schemas, optionally scripts (read-only)
└── state/            tier 3 — per-installation accumulated state (runtime writes here)
```

The runtime in this repo operates against a bundle. For our own use, the bundle is `~/code/sovereign-ai-docs/`. For a client, it's the directory produced by `harness/scripts/extract-harness.mjs` in that docs repo, customised during onboarding.

**What the runtime reads:**

- `<bundle>/index.yaml` — manifest (reading order, doc IDs, summaries).
- `<bundle>/business/**` — loaded lazily via `getBusinessDoc(bundle, relPath)`. Individual docs pulled into the system prompt on demand.
- `<bundle>/state/CONTEXT.md` — pre-digested briefing; injected into the system prompt as a cacheable segment.
- `<bundle>/state/memory/preferences.md` — USER.md analogue; cacheable segment.
- `<bundle>/state/memory/decisions-made.md` — decisions digest; cacheable segment.
- `<bundle>/state/memory/session-log.md` — **tail-read only** (last 3–5 entries); not cacheable.
- `<bundle>/harness/schemas/**` — JSON Schemas for the runtime's own validation (entities, decisions, open-questions, tags).
- `<bundle>/business/glossary.md` — vocabulary injection when a session touches terms that resolve there.

**What the runtime writes:**

- `<bundle>/state/memory/session-log.md` — appends a session entry at end of turn (Hermes pattern).
- `<bundle>/state/trajectories/<session-id>.jsonl` — one JSONL record per turn (Hermes pattern, Phase 2+).
- `<bundle>/state/memory/MEMORY.md` — curated memory, written by the background review loop (Phase 13+).
- `<bundle>/state/artifacts/` — runtime-generated artefacts (chunk output, reconciliation reports).

**What the runtime never writes:**

- `<bundle>/business/**` — tier 1 is read-only to the runtime. Humans and Claude Code sessions on the docs repo author business content. The runtime *consumes* it.
- `<bundle>/harness/scripts/**`, `<bundle>/harness/schemas/**` — tier 2 code / config is read-only.

This contract is enforced at the code level: the loader has `readBusinessDoc(bundle, relPath)` but no corresponding `writeBusinessDoc`. State writes go through explicit helpers in `src/memory/`, `src/trajectory/`, `src/review/`.

## Multi-bundle usage

The runtime operates on one bundle at a time. Passing a different `--bundle` path launches a conversation against a different business context with its own `state/`. This is how the same binary serves client zero (us) and client one (the first paying deployment): both get the same harness, operating against different bundles.
