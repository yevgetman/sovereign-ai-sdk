import { describe, expect, test } from 'bun:test';
import { applyTransition, shouldRun } from '../../src/mission/fsm.js';

describe('shouldRun', () => {
  test('returns true for non-terminal states', () => {
    expect(shouldRun('planning')).toBe(true);
    expect(shouldRun('active')).toBe(true);
    expect(shouldRun('overtime')).toBe(true);
  });
  test('returns false for terminal states', () => {
    expect(shouldRun('complete')).toBe(false);
    expect(shouldRun('abandoned')).toBe(false);
  });
});

describe('applyTransition', () => {
  test('planning → active', () => {
    expect(applyTransition('planning', 'active')).toBe('active');
  });
  test('planning → abandoned', () => {
    expect(applyTransition('planning', 'abandoned')).toBe('abandoned');
  });
  test('active → overtime', () => {
    expect(applyTransition('active', 'overtime')).toBe('overtime');
  });
  test('active → complete', () => {
    expect(applyTransition('active', 'complete')).toBe('complete');
  });
  test('active → abandoned', () => {
    expect(applyTransition('active', 'abandoned')).toBe('abandoned');
  });
  test('overtime → complete', () => {
    expect(applyTransition('overtime', 'complete')).toBe('complete');
  });
  test('overtime → active (step back)', () => {
    expect(applyTransition('overtime', 'active')).toBe('active');
  });
  test('overtime → abandoned', () => {
    expect(applyTransition('overtime', 'abandoned')).toBe('abandoned');
  });
  test('returns current state when sentinel is undefined', () => {
    expect(applyTransition('active', undefined)).toBe('active');
  });
  test('returns current state for invalid sentinel (no valid transition)', () => {
    expect(applyTransition('active', 'bogus')).toBe('active');
  });
  test('throws on transition from terminal state', () => {
    expect(() => applyTransition('complete', 'active')).toThrow(/terminal/);
    expect(() => applyTransition('abandoned', 'active')).toThrow(/terminal/);
  });
  test('invalid transition from planning (e.g. planning → complete) returns current state', () => {
    expect(applyTransition('planning', 'complete')).toBe('planning');
  });
});
