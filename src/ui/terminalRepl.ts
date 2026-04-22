// Terminal REPL. Phase 0: stub — prints a friendly message and exits.
// Phase 1: plain readline loop consuming the query() generator, streaming
// text deltas to stdout. Phase 14: Ink-based rich UI.

export async function runRepl(opts: { bundlePath: string }): Promise<void> {
  process.stdout.write(
    `sovereign-ai-harness — Phase 0 scaffold\nbundle: ${opts.bundlePath}\n\nREPL not yet implemented. See ~/code/sovereign-ai-docs/harness/docs/runtime-scaffold-plan.md § Phase 1.\n`,
  );
}
