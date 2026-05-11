// Phase 16.0b — bottom status line. Shows profile, cwd (basename),
// provider · model, session cost, and a thinking indicator. Phase 16.7
// will add a cache-hit rate, route info, and richer per-tool state.

import { basename } from 'node:path';
import { Box, Text } from 'ink';
import type { UiState, UiStatus } from './state/types.js';

type StatusLineProps = {
  readonly statusLine: UiState['statusLine'];
  readonly status: UiStatus;
};

export function StatusLine({ statusLine, status }: StatusLineProps): JSX.Element {
  const parts: string[] = [];
  parts.push(statusLine.profile);
  parts.push(basename(statusLine.cwd) || '.');
  if (statusLine.provider !== undefined && statusLine.model !== undefined) {
    parts.push(`${statusLine.provider} · ${statusLine.model}`);
  }
  if (statusLine.sessionCostUsd !== undefined) {
    parts.push(`$${statusLine.sessionCostUsd.toFixed(2)}`);
  }
  if (status === 'thinking') parts.push('thinking…');
  if (status === 'tool') parts.push('tool…');
  return (
    <Box>
      <Text dimColor>{parts.join(' · ')}</Text>
    </Box>
  );
}
