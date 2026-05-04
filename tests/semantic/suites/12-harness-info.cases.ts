// HarnessInfo + self-doc tests. Guards the user's reported failure mode
// (transcript 2026-05-04T16-05-05Z): when asked how to integrate an MCP
// server with this harness, the agent fell back to generic Claude-Desktop
// guidance and pointed at ~/.harness/config.json instead of .harness/
// settings.json. Two seams should now make this work end-to-end:
//   - The <harness-self-doc> system-prompt segment teaches the schemas.
//   - HarnessInfo exposes the live state (configured servers, layers).
// The test asks the user's actual question and verifies the answer is
// grounded in this harness, not generic SDK / Claude-Desktop recall.
//
// We use the echo-server fixture from tests/mcp/ so the case is offline
// and self-contained.

import { join } from 'node:path';
import type { SemanticTest } from '../framework/types.js';

const FIXTURE = join(import.meta.dir, '..', '..', 'mcp', 'fixtures', 'echo-server.ts');

export const tests: SemanticTest[] = [
  {
    id: 'harness-info-config-and-extension-guidance',
    name: 'Agent reports the configured MCP server and explains the right place to add another',
    description:
      'Guards against the agent answering meta-questions about the harness with generic recall. ' +
      'The system-prompt self-doc segment plus the HarnessInfo tool should let the agent name the ' +
      'configured server and point at the correct settings file (.harness/settings.json with an ' +
      'mcpServers key) — not ~/.harness/config.json (provider/theme only) and not ~/.claude/.',
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
      'What MCP servers are currently configured for this harness session, and where would I edit ' +
      'settings to add another one? Be specific about the file path.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent identifies "echo" (or echoes the alias verbatim) as a configured MCP server.',
        'The agent points at .harness/settings.json or .harness/settings.local.json (a settings layer file under .harness/) as the place to add MCP servers.',
        'The agent references the mcpServers key as the location for the new entry.',
      ],
      shouldNot: [
        'The agent recommends editing ~/.harness/config.json (that file holds provider/theme/debug only).',
        'The agent recommends ~/.claude/claude.json, claude_desktop_config.json, or any Claude Desktop path.',
        "The agent tells the user to invoke ToolSearch (ToolSearch is the model's tool, not a user-facing config mechanism).",
        'The agent claims no MCP servers are configured.',
      ],
    },
    timeoutMs: 90_000,
  },
];
