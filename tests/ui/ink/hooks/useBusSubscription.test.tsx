import { describe, expect, it } from 'bun:test';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { JSX } from 'react';
import { useReducer } from 'react';
import { DaemonEventBus } from '../../../../src/daemon/eventBus.js';
import { useBusSubscription } from '../../../../src/ui/ink/hooks/useBusSubscription.js';
import { initialUiState, reduce } from '../../../../src/ui/ink/state/reducer.js';

function Harness({ bus }: { readonly bus: DaemonEventBus }): JSX.Element {
  const [state, dispatch] = useReducer(reduce, initialUiState);
  useBusSubscription(bus, dispatch);
  const taskCount = Object.keys(state.tasks).length;
  const lastSystemText =
    [...state.transcript].reverse().find((m) => m.role === 'system')?.text ?? '';
  return <Text>{`tasks=${taskCount} sys=${lastSystemText}`}</Text>;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('useBusSubscription', () => {
  it('dispatches task_update bus events into the reducer', async () => {
    const bus = new DaemonEventBus();
    const { lastFrame, rerender } = render(<Harness bus={bus} />);
    await flush();
    expect(lastFrame() ?? '').toContain('tasks=0');
    bus.emit({ type: 'task_update', taskId: 't1', state: 'queued' });
    await flush();
    rerender(<Harness bus={bus} />);
    await flush();
    expect(lastFrame() ?? '').toContain('tasks=1');
  });

  it('dispatches daemon_stopping bus events as a system message', async () => {
    const bus = new DaemonEventBus();
    const { lastFrame, rerender } = render(<Harness bus={bus} />);
    await flush();
    bus.emit({ type: 'daemon_stopping', reason: 'sigterm' });
    await flush();
    rerender(<Harness bus={bus} />);
    await flush();
    expect(lastFrame() ?? '').toContain('daemon stopping');
    expect(lastFrame() ?? '').toContain('sigterm');
  });

  it('detaches handlers on unmount so emits after unmount do not throw', async () => {
    const bus = new DaemonEventBus();
    const { unmount } = render(<Harness bus={bus} />);
    await flush();
    unmount();
    await flush();
    // No subscribers — this should be a no-op, not a throw.
    expect(() => bus.emit({ type: 'task_update', taskId: 't2', state: 'queued' })).not.toThrow();
  });
});
