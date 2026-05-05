// Router tests (Phase 10.6 part 1). Verify that `--provider router`
// resolves the configured local + frontier child providers, classifies
// the turn, and runs to completion. Both lanes point at anthropic so a
// single ANTHROPIC_API_KEY (already in the test env from .env auto-load)
// covers the run.
//
// We don't assert on which lane was chosen — the classifier defaults to
// local for unremarkable prompts, but we'd rather verify the user-facing
// experience (the agent answers correctly in router mode) than couple
// the test to internal classifier details. The unit suite covers the
// classifier rules directly.

import type { SemanticTest } from '../framework/types.js';

export const tests: SemanticTest[] = [
  {
    id: 'router-completes-turn',
    name: '--provider router resolves both lanes and runs a turn',
    description:
      'Guards against the router meta-provider failing to wrap child providers, the synthetic ' +
      'ResolvedProvider missing a required field (contextLength, model, metadata), or the audit logger ' +
      'blocking session start. Both lanes point at anthropic so the same API key covers either lane.',
    category: 'router',
    setup: {
      userConfig: {
        router: {
          localProvider: 'anthropic',
          localModel: 'claude-haiku-4-5',
          frontierProvider: 'anthropic',
          frontierModel: 'claude-sonnet-4-6',
          escalationMode: 'never',
          defaultLane: 'local',
        },
      },
    },
    prompt: 'What is 2 + 2? Reply with just the number.',
    binaryArgs: ['--provider', 'router'],
    judgeCriteria: {
      mustSatisfy: [
        'The agent successfully started a session in router mode (the splash card or status footer shows "router").',
        'The agent answered the question with the number 4 (or "four").',
        'The transcript includes a per-turn router banner of the form "[router … local …]" that names the chosen lane and the resolved provider/model (Phase 10.6 part 2 surface).',
      ],
      shouldNot: [
        'The agent reported a configuration error like "router config missing", "unknown provider", or "router requires".',
        'The session aborted before producing any response.',
      ],
    },
    timeoutMs: 60_000,
  },
];
