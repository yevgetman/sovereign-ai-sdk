// Terminal message formatting helpers kept pure for focused tests.

export type MaxTokensWarningInput = {
  maxTokens: number;
  sessionId: string;
  /** Bundle path to embed in the resume command, or null in generic-agent mode. */
  bundlePath: string | null;
};

export type PartialMutationWarningInput = {
  paths: string[];
};

export function formatMaxTokensWarning(input: MaxTokensWarningInput): string {
  const suggested = suggestHigherMaxTokens(input.maxTokens);
  const bundleArg = input.bundlePath !== null ? ` --bundle ${quoteShellArg(input.bundlePath)}` : '';
  return [
    `[max tokens] provider stopped because this turn hit --max-tokens=${input.maxTokens}`,
    'The partial response was saved. Continue in this session, or resume with a higher output budget:',
    `sov --resume ${input.sessionId}${bundleArg} --max-tokens ${suggested}`,
    'For large code edits, ask for smaller FileWrite/FileEdit patches instead of full replacement files in chat.',
  ].join('\n');
}

export function suggestHigherMaxTokens(current: number): number {
  return Math.ceil((current * 1.5) / 1000) * 1000;
}

export function formatPartialMutationWarning(input: PartialMutationWarningInput): string {
  const paths = [...new Set(input.paths)].sort();
  const shown = paths.slice(0, 8);
  const hidden = paths.length - shown.length;
  return [
    '[partial changes] provider failed after mutating tool calls completed.',
    'Validate the workspace before relying on the artifact. Touched paths:',
    ...shown.map((path) => `- ${path}`),
    ...(hidden > 0 ? [`- ... ${hidden} more`] : []),
  ].join('\n');
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
