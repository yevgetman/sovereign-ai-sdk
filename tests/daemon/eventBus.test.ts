import { describe, expect, test } from 'bun:test';
import { DaemonEventBus } from '../../src/daemon/eventBus.js';

describe('DaemonEventBus', () => {
  test('on + emit delivers typed event to handler', () => {
    const bus = new DaemonEventBus();
    const received: number[] = [];
    bus.on('daemon_started', (e) => received.push(e.pid));
    bus.emit({ type: 'daemon_started', pid: 42, profile: 'default', harnessHome: '/tmp' });
    expect(received).toEqual([42]);
  });

  test('off removes handler — no more deliveries after off', () => {
    const bus = new DaemonEventBus();
    const log: string[] = [];
    const handler = (e: { type: 'daemon_stopping'; reason: string }) => log.push(e.reason);
    bus.on('daemon_stopping', handler);
    bus.off('daemon_stopping', handler);
    bus.emit({ type: 'daemon_stopping', reason: 'explicit' });
    expect(log).toHaveLength(0);
  });

  test('multiple handlers for same event type all fire in registration order', () => {
    const bus = new DaemonEventBus();
    const order: number[] = [];
    bus.on('daemon_stopping', () => order.push(1));
    bus.on('daemon_stopping', () => order.push(2));
    bus.emit({ type: 'daemon_stopping', reason: 'explicit' });
    expect(order).toEqual([1, 2]);
  });
});
