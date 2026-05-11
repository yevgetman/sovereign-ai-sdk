// src/mission/fsm.ts
// Mission FSM: valid state transitions for Phase 13.5 scheduled missions.

import type { MissionFsmState } from './types.js';

const TERMINAL_STATES = new Set<MissionFsmState>(['complete', 'abandoned']);

const TRANSITIONS: Readonly<Record<MissionFsmState, ReadonlySet<MissionFsmState>>> = {
  planning: new Set(['active', 'abandoned']),
  active: new Set(['overtime', 'complete', 'abandoned']),
  overtime: new Set(['active', 'complete', 'abandoned']),
  complete: new Set(),
  abandoned: new Set(),
};

export function shouldRun(state: MissionFsmState): boolean {
  return !TERMINAL_STATES.has(state);
}

export function applyTransition(
  current: MissionFsmState,
  sentinel: string | undefined,
): MissionFsmState {
  if (TERMINAL_STATES.has(current)) {
    throw new Error(`mission is in terminal state "${current}" — no transitions allowed`);
  }
  if (sentinel === undefined) return current;
  const target = sentinel as MissionFsmState;
  if (!TRANSITIONS[current].has(target)) return current;
  return target;
}
