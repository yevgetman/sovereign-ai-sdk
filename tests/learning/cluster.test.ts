import { describe, expect, test } from 'bun:test';
import { clusterKey, clusterObservations } from '../../src/learning/cluster.js';
import type { Observation } from '../../src/learning/types.js';

function obs(partial: Partial<Observation> = {}): Observation {
  return {
    id: partial.id ?? 'obs-1',
    ts: partial.ts ?? '2026-05-06T00:00:00Z',
    project_id: partial.project_id ?? 'p',
    project_name: partial.project_name ?? 'pp',
    session_id: partial.session_id ?? 's',
    tool_name: partial.tool_name ?? 'Bash',
    tool_input_hash: partial.tool_input_hash ?? 'sha256:x',
    tool_input_summary: partial.tool_input_summary ?? 'cmd',
    status: partial.status ?? 'success',
    duration_ms: partial.duration_ms ?? 10,
  };
}

describe('clusterKey', () => {
  test('joins tool_name, truncated tool_input_summary, status with ::', () => {
    const o = obs({ tool_name: 'Bash', tool_input_summary: 'ls -la', status: 'success' });
    expect(clusterKey(o)).toBe('Bash::ls -la::success');
  });

  test('truncates tool_input_summary to 80 chars', () => {
    const o = obs({ tool_input_summary: 'a'.repeat(200) });
    const k = clusterKey(o);
    const [, ap] = k.split('::');
    expect(ap?.length).toBe(80);
  });

  test('different tool_name → different key', () => {
    expect(clusterKey(obs({ tool_name: 'A' }))).not.toBe(clusterKey(obs({ tool_name: 'B' })));
  });

  test('different status → different key', () => {
    expect(clusterKey(obs({ status: 'success' }))).not.toBe(clusterKey(obs({ status: 'error' })));
  });
});

describe('clusterObservations', () => {
  test('groups same-key observations and sorts by size descending', () => {
    const list: Observation[] = [
      obs({ id: 'a1', tool_name: 'Bash', tool_input_summary: 'ls', status: 'success' }),
      obs({ id: 'a2', tool_name: 'Bash', tool_input_summary: 'ls', status: 'success' }),
      obs({ id: 'a3', tool_name: 'Bash', tool_input_summary: 'ls', status: 'success' }),
      obs({ id: 'b1', tool_name: 'Grep', tool_input_summary: 'foo', status: 'success' }),
      obs({ id: 'c1', tool_name: 'Bash', tool_input_summary: 'ls', status: 'error' }),
    ];
    const clusters = clusterObservations(list);
    expect(clusters.length).toBe(3);
    expect(clusters[0]?.observations.length).toBe(3); // 3 ls success
    expect(clusters[1]?.observations.length).toBe(1); // ties broken by insertion; either Grep or ls error
    expect(clusters[2]?.observations.length).toBe(1);
  });

  test('determinism: same input → same key ordering when sizes differ', () => {
    const list: Observation[] = [
      obs({ id: 'a', tool_name: 'A', tool_input_summary: 'x', status: 'success' }),
      obs({ id: 'b', tool_name: 'A', tool_input_summary: 'x', status: 'success' }),
      obs({ id: 'c', tool_name: 'B', tool_input_summary: 'x', status: 'success' }),
    ];
    const c1 = clusterObservations(list);
    const c2 = clusterObservations(list);
    expect(c1.map((c) => c.key)).toEqual(c2.map((c) => c.key));
    expect(c1[0]?.key).toContain('A'); // 2-member cluster first
  });

  test('empty input returns empty array', () => {
    expect(clusterObservations([])).toEqual([]);
  });
});
