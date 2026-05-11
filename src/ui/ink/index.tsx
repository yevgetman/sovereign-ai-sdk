// Phase 16.0b — Ink TUI entry. startInkTUI() acquires the daemon lock,
// instantiates the bus + caches, mounts <App>, and waits for exit.

import { render } from 'ink';
import { resolveHarnessHome } from '../../config/paths.js';
import { startDaemon } from '../../daemon/runner.js';
import { App } from './App.js';

export type StartInkTUIOpts = {
  readonly bundlePath?: string;
};

export async function startInkTUI(_opts: StartInkTUIOpts = {}): Promise<number> {
  const home = resolveHarnessHome();
  const daemon = startDaemon({ harnessHome: home });
  const instance = render(<App cwd={process.cwd()} profile={home} />);
  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    daemon.shutdown();
  }
}
