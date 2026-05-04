// MCP tests (Phase 12). Spawn the echo-server fixture from tests/mcp/
// as a real MCP server, point the harness at it via .harness/settings.local.json,
// and verify the agent can discover the tool via ToolSearch and invoke it.
//
// Why the echo fixture and not @modelcontextprotocol/server-filesystem:
//   - No `npx` download required → tests run offline.
//   - Self-contained behavior we control (echo / boom / slow).
//
// The fixture imports from the harness's own node_modules (the SDK is a
// direct dep), so spawning `bun /abs/path/to/echo-server.ts` works as long
// as the harness repo is on disk — which is the only way `sov` is invoked
// in the semantic suite anyway.

import { join } from 'node:path';
import type { SemanticTest } from '../framework/types.js';

const FIXTURE = join(import.meta.dir, '..', '..', 'mcp', 'fixtures', 'echo-server.ts');

export const tests: SemanticTest[] = [
  {
    id: 'mcp-tool-search-then-invoke',
    name: 'Agent uses ToolSearch to discover the MCP tool, then invokes it',
    description:
      'Guards against the orchestrator forgetting to merge MCP tools into the pool, schemaSerialization ' +
      'mishandling deferred tools, or ToolSearch failing to surface the full schema. We use a deliberately ' +
      'unique echo token so the only way the agent can produce it is by actually invoking the MCP tool.',
    category: 'tools',
    setup: {
      files: [
        {
          path: '.harness/settings.local.json',
          content: JSON.stringify(
            {
              mcpServers: {
                echo: { command: 'bun', args: [FIXTURE] },
              },
            },
            null,
            2,
          ),
        },
      ],
    },
    prompt:
      'Use the echo MCP tool to echo back the literal text "mcp-roundtrip-token-7p3q9". ' +
      'Tell me what the tool returned.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invoked ToolSearch (or some discovery mechanism) to look up the deferred MCP tool schema.',
        'The agent invoked the mcp__echo__echo tool with the requested text.',
        'The agent reported "mcp-roundtrip-token-7p3q9" in its final response, attributed to the tool result.',
      ],
      shouldNot: [
        'The agent fabricated the echo result without actually calling the MCP tool.',
        'The agent claimed it has no access to MCP tools.',
      ],
    },
    timeoutMs: 90_000,
  },
  {
    id: 'mcp-permission-rule-blocks-server',
    name: 'A deny rule on `mcp__echo` blocks every tool from that server',
    description:
      'Guards against MCP tools bypassing the permission system. The deny rule should match the prefix ' +
      '`mcp__echo` and block the call before it reaches the server. The agent must report the block.',
    category: 'permissions',
    setup: {
      files: [
        {
          path: '.harness/settings.local.json',
          content: JSON.stringify(
            {
              mcpServers: {
                echo: { command: 'bun', args: [FIXTURE] },
              },
              permissions: { deny: ['mcp__echo'] },
            },
            null,
            2,
          ),
        },
      ],
    },
    prompt: 'Use the echo MCP tool to echo back "mcp-blocked-token-zz4". Tell me what happened.',
    binaryArgs: ['--permission-mode', 'default'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent attempted (or considered) calling the mcp__echo__echo tool.',
        'The transcript shows the call was blocked, denied, or rejected by the permission system.',
        "The agent's final response acknowledges that it could not run the MCP tool.",
      ],
      shouldNot: [
        'The agent reported "mcp-blocked-token-zz4" as if the call had succeeded.',
        'The agent claimed the echo succeeded.',
      ],
    },
    timeoutMs: 90_000,
  },
];
