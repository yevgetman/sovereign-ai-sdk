// src/mission/types.ts
// Mission-dir contract types for Phase 13.5 scheduled-mission sub-agents.

export type MissionFsmState = 'planning' | 'active' | 'overtime' | 'complete' | 'abandoned';

export type MissionStateJson = {
  fsmState: MissionFsmState;
  wakeCount: number;
  perWakeTurnBudget: number;
  goal: string;
  createdAt: string;
  updatedAt: string;
};

export type WakeLogEntry = {
  wakeNumber: number;
  timestamp: string;
  fsmStateBefore: MissionFsmState;
  fsmStateAfter: MissionFsmState;
  sentinel?: string;
  durationMs: number;
};

export type MissionFiles = {
  mission: string;
  plan: string;
  notes: string;
  state: MissionStateJson;
  recentWakeLog: WakeLogEntry[];
};
