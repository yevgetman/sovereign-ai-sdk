// Terminal message formatting helpers kept pure for focused tests.

export type MaxTokensWarningInput = {
  maxTokens: number;
  sessionId: string;
  bundlePath: string;
};

export function formatMaxTokensWarning(input: MaxTokensWarningInput): string {
  const suggested = suggestHigherMaxTokens(input.maxTokens);
  return [
    `[max tokens] provider stopped because this turn hit --max-tokens=${input.maxTokens}`,
    'The partial response was saved. Continue in this session, or resume with a higher output budget:',
    `sovereign chat --resume ${input.sessionId} --bundle ${quoteShellArg(input.bundlePath)} --max-tokens ${suggested}`,
    'For large code edits, ask for smaller FileWrite/FileEdit patches instead of full replacement files in chat.',
  ].join('\n');
}

export function suggestHigherMaxTokens(current: number): number {
  return Math.ceil((current * 1.5) / 1000) * 1000;
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
