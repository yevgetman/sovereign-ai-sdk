// Phase 16.0b — subscribes the TUI dispatch to DaemonEventBus events.
// Currently maps:
//   - task_update      -> reducer task_update
//   - daemon_stopping  -> reducer system_message
// Other bus events (approval_*, session_*) are accepted by the bus for
// forward-compatibility but not rendered yet — the approval UI lands in
// Phase 16.0c.
//
// Listeners attach in useEffect so they outlive React's render cycle and
// detach on unmount + on identity change of either bus or dispatch. The
// dispatch callback identity is stable across renders when produced by
// React's useReducer, so the effect re-runs in practice only when the
// bus reference itself changes.

import { useEffect } from 'react';
import type { DaemonEventBus } from '../../../daemon/eventBus.js';
import type { DaemonEventMap } from '../../../daemon/types.js';
import type { UiEvent } from '../state/types.js';

export function useBusSubscription(bus: DaemonEventBus, dispatch: (event: UiEvent) => void): void {
  useEffect(() => {
    const onTaskUpdate = (e: DaemonEventMap['task_update']): void => {
      dispatch({ type: 'task_update', taskId: e.taskId, state: e.state });
    };
    const onDaemonStopping = (e: DaemonEventMap['daemon_stopping']): void => {
      dispatch({ type: 'system_message', text: `daemon stopping (${e.reason})` });
    };
    bus.on('task_update', onTaskUpdate);
    bus.on('daemon_stopping', onDaemonStopping);
    return (): void => {
      bus.off('task_update', onTaskUpdate);
      bus.off('daemon_stopping', onDaemonStopping);
    };
  }, [bus, dispatch]);
}
