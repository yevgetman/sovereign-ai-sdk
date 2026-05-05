// Phase 13 — sub-agent / AgentTool semantic test. Verifies that, given the
// three reference agents shipped in bundle-default/agents/, the model both
// knows AgentTool exists AND uses it for the right kind of prompt.
//
// We don't actually drive a sub-agent end-to-end here (that'd be expensive
// and noisy in a semantic suite — the unit + integration tests in
// tests/runtime/scheduler*.test.ts already cover scheduler behavior).
// Instead we ask a meta-question that exercises the model's awareness of
// the AgentTool surface and the loaded agent registry — guarding against
// regressions where AgentTool gets dropped from the pool, the
// subagent_type enum stops being patched, or the model can't see the
// agents shipped in the default bundle.

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
];
