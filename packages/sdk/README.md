# @yevgetman/sov-sdk

The open-core Sovereign AI SDK — an embeddable, provider-agnostic agent-loop
engine. `createAgent()` gives you a Claude-Code-style turn loop with tools,
skills, MCP, hooks, memory/recall ports, and injectable persistence — with no
disk, no server, and no proprietary code required for a bare turn.

Runs on Node ≥20 and Bun ≥1.2.

```ts
import { createAgent } from "@yevgetman/sov-sdk";
```

The public API is the package entry (`@yevgetman/sov-sdk`). Deep subpaths
(`@yevgetman/sov-sdk/*`) are shipped for advanced/internal use and are not
covered by semver.

> Full quickstart & API docs land in the publish-readiness phase.
