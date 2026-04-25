// MemoryManager provider rules: bundled provider is always allowed, but only
// one external provider may be active at once.

import { describe, expect, test } from 'bun:test';
import {
  BuiltinMarkdownMemoryProvider,
  MemoryManager,
  type MemoryProvider,
} from '../../src/memory/provider.js';

function external(id: string): MemoryProvider {
  return {
    id,
    builtin: false,
    isAvailable: () => true,
    initialize: async () => {},
    getToolSchemas: () => [],
    handleToolCall: async () => '',
    prefetchSnapshot: async () => '',
    syncTurn: async () => {},
    onMemoryWrite: async () => {},
    onDelegation: async () => {},
    onSessionStart: async () => {},
    onSessionEnd: async () => {},
    shutdown: async () => {},
  };
}

describe('MemoryManager', () => {
  test('allows bundled plus one external provider, rejects a second external', () => {
    const manager = new MemoryManager();
    manager.addProvider(new BuiltinMarkdownMemoryProvider('/tmp/harness-memory-test'));
    manager.addProvider(external('one'));
    expect(() => manager.addProvider(external('two'))).toThrow(/only one external/);
  });
});
