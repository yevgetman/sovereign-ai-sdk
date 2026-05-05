// Phase 13 — sub-agent / AgentTool semantic tests. Two cases:
//
// 1. Registry-discoverability — the model can name the loaded agents and
//    describe their roles. Guards against the agents/ directory not being
//    scanned, AgentTool getting dropped, or the schema patch silently
//    regressing.
//
// 2. Live delegation — the model actually invokes AgentTool with a real
//    subagent_type, the scheduler spawns a child session, the child runs
//    to terminal, and the parent uses the structured result. This is the
//    end-to-end smoke for the entire Phase 13 chain (loader → scheduler →
//    AgentRunner → query → renderResult → parent consumption). Unit +
//    integration tests cover the mechanism deterministically with fake
//    providers; this case adds the live-model layer that catches issues
//    the deterministic tests can't reach: AgentTool description quality,
//    subagent_type enum being usable, renderResult envelope being
//    parseable, parent model knowing what to do with the wrapped result.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'agents-bundle-default-discoverable',
    name: 'Agent reports the available sub-agents from the default bundle',
    description:
      'Phase 13 ships explore / verify / plan in bundle-default/agents/. The harness should ' +
      'load them at startup, AgentTool should be in the active tool pool with subagent_type ' +
      'patched to a closed enum, and HarnessInfo (or a direct introspection) should let the ' +
      'model name them when asked. Guards against: agents/ dir not being scanned, AgentTool ' +
      'getting dropped, or the schema patch silently regressing.',
    category: 'tools',
    prompt:
      'What sub-agents are available in this harness session right now? List them by name and ' +
      'briefly describe what each is good for. Do not speculate about agents that are not ' +
      'actually loaded — only report what you can confirm is registered.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent names "explore" as one of the available sub-agents.',
        'The agent names "verify" as one of the available sub-agents.',
        'The agent names "plan" as one of the available sub-agents.',
        "The agent describes each sub-agent's purpose at least roughly correctly (explore = codebase mapping / file search; verify = independent claim checking; plan = implementation planning).",
      ],
      shouldNot: [
        'The agent invents sub-agents that are not actually loaded (e.g. "researcher", "coder", "writer").',
        'The agent claims no sub-agents are available.',
        'The agent confuses sub-agents with skills (skills are markdown procedures, sub-agents are delegated sessions).',
      ],
    },
    timeoutMs: 90_000,
  },
  {
    id: 'agents-explore-live-delegation',
    name: 'Parent invokes the explore sub-agent and uses the structured result',
    description:
      'End-to-end smoke for Phase 13: parent invokes AgentTool with subagent_type=explore, ' +
      'scheduler spawns a child session, child runs to terminal with read-only tools, ' +
      "renderResult emits a <subagent_result> envelope, and the parent uses the child's " +
      'finding to answer the original question. Catches regressions across the full chain — ' +
      'AgentTool throwing, scheduler failing to resolve provider, child session failing to ' +
      'start, renderResult wrapping breaking, or the parent model not understanding how to ' +
      'consume the wrapped result. Unit + integration tests cover the mechanism with fake ' +
      'providers; this case adds the live-model layer.',
    category: 'tools',
    setup: {
      files: [
        {
          path: 'src/auth.py',
          content:
            '# Authentication module — verifies bearer tokens against the user store.\n' +
            'BEARER_PREFIX = "Bearer "\n' +
            'TOKEN_LOOKUP_TABLE = {\n' +
            '    "demo-token-AUTH-MARKER-9F4E2A": "user-1",\n' +
            '}\n' +
            '\n' +
            'def verify_token(authorization_header: str) -> str | None:\n' +
            '    """Returns the user id when the bearer token is known, else None."""\n' +
            '    if not authorization_header.startswith(BEARER_PREFIX):\n' +
            '        return None\n' +
            '    token = authorization_header[len(BEARER_PREFIX):]\n' +
            '    return TOKEN_LOOKUP_TABLE.get(token)\n',
        },
        {
          path: 'README.md',
          content:
            '# Demo Repo\n\n' +
            'Tiny project with one module: `src/auth.py` (token verification).\n',
        },
      ],
    },
    prompt:
      'I want to understand how authentication works in this repo. Use the `explore` sub-agent ' +
      '(via the AgentTool) to investigate `src/auth.py` and report back what the file does. ' +
      'After the sub-agent reports, summarize its findings for me in plain language.',
    binaryArgs: ['--permission-mode', 'bypass'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent invokes the AgentTool tool with subagent_type set to "explore" (visible as a tool call in the transcript).',
        "The transcript shows evidence the sub-agent ran and produced a result (the response either contains a <subagent_result …> tag from renderResult, or the parent quotes/references concrete details from the sub-agent's findings).",
        "The agent's final summary references something specific from src/auth.py — e.g. the verify_token function, the bearer-token verification flow, the TOKEN_LOOKUP_TABLE, or the BEARER_PREFIX constant. (The exact identifier doesn't matter as long as it's grounded in the actual file content.)",
      ],
      shouldNot: [
        'The agent fabricates information about src/auth.py without delegating to the explore sub-agent (would mean the AgentTool path was bypassed).',
        'The agent claims AgentTool or the explore sub-agent is unavailable.',
        "The agent's final summary is empty or just describes that it tried to delegate without producing actual findings.",
        'The agent\'s response contains the literal demo token "demo-token-AUTH-MARKER-9F4E2A" (the token is structured to NOT match any redactor pattern, so this is a content-discipline check — explore should describe the structure, not paste the token).',
      ],
    },
    // Live delegation runs the full chain: parent turn → AgentTool call →
    // child session creation + provider resolution + AgentRunner → child
    // turn(s) → renderResult → parent consumption turn. 3-5 model calls
    // typical; budget extra time + don't mark slow (the value of catching
    // a chain regression is high).
    timeoutMs: 180_000,
  },
];
