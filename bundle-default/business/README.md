# Default bundle

This is the default harness bundle shipped with the `sov` runtime. It's used when no other bundle is resolved — no `--bundle` flag, no `HARNESS_BUNDLE` env var, no `index.yaml` found by walking up from your current directory, and no user-installed override at `<harness-home>/default-bundle/`.

The default bundle is intentionally generic: a vendor-neutral coding-assistant system prompt and a small set of starter skills. It does **not** ship with any product-specific identity, business knowledge, schemas, or workflow opinions. Those belong in a real bundle that you (or your team) author.

## What's in here

```
bundle-default/
├── index.yaml                # Manifest
├── business/
│   ├── README.md             # This file
│   └── system-prompt.md      # Generic coding-assistant prompt
├── harness/schemas/          # Empty — the default bundle ships no schemas
├── state/                    # Empty — populated on first session
└── skills/
    ├── review.md             # `/review` — code-review checklist
    └── summarize.md          # `/summarize` — quick summary of a file or repo
```

## How to customize

Two paths:

1. **Override the default in place.** Drop a directory at `<harness-home>/default-bundle/` (default: `~/.harness/default-bundle/`) with the same shape as this one. The override takes precedence over the shipped default — useful for personalizing the system prompt, adding skills, etc., without forking the runtime.

2. **Graduate to a real bundle.** Run `sov init` from the directory where your project lives. It creates a minimal `index.yaml` + `business/` + `harness/` + `state/` skeleton, optionally bootstrapped from the current repo. Then point `sov` at it via `--bundle <path>` or `HARNESS_BUNDLE` (or just run `sov` from inside that directory — the upward walk picks it up).

A "real bundle" is the load-bearing extension surface for the harness: it carries your project's identity, its tier-1 business content, your custom schemas, and everything else specific to your work. The default is a starting point, not a destination.

## See also

- The runtime repo's `src/bundle/README.md` — the bundle-as-data contract (what tiers exist, what the runtime reads vs writes).
- `sov init --help` — bootstrap a directory into a real bundle.
