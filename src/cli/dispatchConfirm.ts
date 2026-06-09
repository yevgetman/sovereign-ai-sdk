// `sov dispatch` TTY-consent helper (T8) — builds the injected yes/no `confirm`
// that `/plugins install`'s disclose-and-consent flow (S3) needs.
//
// Two invariants this owns:
//   1. Non-TTY ⇒ NO confirm. A scripted / piped dispatch has no interactive
//      surface, so `confirm` is undefined and `/plugins install` refuses with
//      its "requires a terminal" message (rather than silently consenting).
//   2. TTY ⇒ a confirm that reads the answer from the dispatch loop's SINGLE
//      stdin consumer (the shared async-iterator's `readLine`). The consent
//      answer is simply "the next line the user types." Reading through the
//      ONE iterator the loop already pulls from avoids the stdin-contention
//      bug where a second readline (or a concurrent `rl.question()` against an
//      actively-iterated interface) fights for / closes the input.
//
// Pure aside from the injected `readLine` call. Kept separate from
// `dispatchCommand.ts` so it is unit-testable without driving the whole stdin
// loop.

/** Pull the next stdin line from the dispatch loop's shared consumer, or `null`
 *  at EOF. The loop and this confirm both read through the SAME function so
 *  there is exactly one consumer of stdin. */
export type ReadLine = () => Promise<string | null>;

/**
 * Build the injected `confirm` for `/plugins install`. Returns `undefined` when
 * stdin is not a TTY (install refuses); otherwise a function that prints the
 * disclosure + a `[yN]` prompt and reads the next line via the SHARED
 * `readLine`, resolving `true` only for `y`/`yes` (case-insensitive, trimmed),
 * `false` for anything else (incl. EOF).
 */
export function buildDispatchConfirm(
  readLine: ReadLine,
  isTty: boolean,
  write: (text: string) => void = (text) => process.stdout.write(text),
): ((prompt: string) => Promise<boolean>) | undefined {
  if (!isTty) return undefined;
  return async (disclosure: string): Promise<boolean> => {
    write(`${disclosure}\n\nProceed with install? [yN] `);
    const answer = await readLine();
    if (answer === null) return false; // EOF mid-prompt ⇒ treat as declined.
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  };
}
