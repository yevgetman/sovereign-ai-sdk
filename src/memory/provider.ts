// Memory provider abstraction plus the bundled bounded-markdown provider.
// External providers can plug in later; only one non-builtin provider may be
// active at once to keep tool/schema bloat bounded.

import { readAllMemory, readProjectMemoryFile } from './bounded.js';
import { formatMemorySnapshot } from './injection.js';
import type { ProjectScope } from './scope.js';

export interface MemoryProvider {
  readonly id: string;
  readonly builtin: boolean;
  isAvailable(): boolean;
  initialize(): Promise<void>;
  getToolSchemas(): unknown[];
  handleToolCall(name: string, args: object): Promise<string>;
  prefetchSnapshot(userMsg: string): Promise<string>;
  syncTurn(userMsg: string, assistantResponse: string): Promise<void>;
  onMemoryWrite(internalChange: object): Promise<void>;
  onDelegation(task: string, result: string): Promise<void>;
  onSessionStart(): Promise<void>;
  onSessionEnd(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface MemoryRuntime {
  prefetchSnapshot(userMsg: string): Promise<string>;
  syncTurn(userMsg: string, assistantResponse: string): Promise<void>;
  onMemoryWrite(change: object): Promise<void>;
  onDelegation(task: string, result: string): Promise<void>;
}

export class BuiltinMarkdownMemoryProvider implements MemoryProvider {
  readonly id = 'builtin-markdown';
  readonly builtin = true;

  private readonly harnessHome: string;
  private readonly projectScope?: ProjectScope;

  constructor(harnessHome: string, projectScope?: ProjectScope) {
    this.harnessHome = harnessHome;
    if (projectScope !== undefined) this.projectScope = projectScope;
  }

  isAvailable(): boolean {
    return true;
  }

  async initialize(): Promise<void> {}
  async onSessionStart(): Promise<void> {}
  async onSessionEnd(_sessionId: string): Promise<void> {}
  async shutdown(): Promise<void> {}
  async syncTurn(_userMsg: string, _assistantResponse: string): Promise<void> {}
  async onMemoryWrite(_internalChange: object): Promise<void> {}
  async onDelegation(_task: string, _result: string): Promise<void> {}

  getToolSchemas(): unknown[] {
    return [];
  }

  async handleToolCall(_name: string, _args: object): Promise<string> {
    return '';
  }

  async prefetchSnapshot(_userMsg: string): Promise<string> {
    const all = readAllMemory(this.harnessHome);
    const projectPart = (() => {
      if (!this.projectScope || this.projectScope.kind !== 'project') return undefined;
      const proj = readProjectMemoryFile(this.projectScope.id, this.harnessHome);
      if (!proj.content.trim()) return undefined;
      return { content: proj.content, name: this.projectScope.name };
    })();
    return formatMemorySnapshot({
      user: all['USER.md'].content,
      memory: all['MEMORY.md'].content,
      ...(projectPart !== undefined ? { projectMemory: projectPart } : {}),
    });
  }
}

export class MemoryManager {
  private readonly providers: MemoryProvider[] = [];
  private turnsSinceWrite = 0;

  constructor(private readonly nudgeEvery = 10) {}

  addProvider(provider: MemoryProvider): void {
    if (!provider.builtin && this.providers.some((p) => !p.builtin)) {
      throw new Error('only one external memory provider may be active');
    }
    this.providers.push(provider);
  }

  async initialize(): Promise<void> {
    for (const provider of this.providers) {
      if (provider.isAvailable()) await provider.initialize();
    }
  }

  async onSessionStart(): Promise<void> {
    for (const provider of this.providers) await provider.onSessionStart();
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    for (const provider of this.providers) await provider.onSessionEnd(sessionId);
  }

  async shutdown(): Promise<void> {
    for (const provider of this.providers) await provider.shutdown();
  }

  async prefetchSnapshot(userMsg: string): Promise<string> {
    this.turnsSinceWrite++;
    const snapshots: string[] = [];
    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;
      const snapshot = await provider.prefetchSnapshot(userMsg);
      if (snapshot.trim()) snapshots.push(snapshot);
    }
    if (this.turnsSinceWrite > 0 && this.turnsSinceWrite % this.nudgeEvery === 0) {
      snapshots.push(
        formatMemorySnapshot({
          nudge:
            'Consider reviewing MEMORY.md and USER.md if this turn surfaced durable facts or preferences.',
        }),
      );
    }
    return snapshots.join('\n\n');
  }

  async syncTurn(userMsg: string, assistantResponse: string): Promise<void> {
    for (const provider of this.providers) await provider.syncTurn(userMsg, assistantResponse);
  }

  async onMemoryWrite(change: object): Promise<void> {
    this.turnsSinceWrite = 0;
    for (const provider of this.providers) await provider.onMemoryWrite(change);
  }

  async onDelegation(task: string, result: string): Promise<void> {
    for (const provider of this.providers) await provider.onDelegation(task, result);
  }
}

export function createDefaultMemoryManager(
  harnessHome: string,
  projectScope?: ProjectScope,
): MemoryManager {
  const manager = new MemoryManager();
  manager.addProvider(new BuiltinMarkdownMemoryProvider(harnessHome, projectScope));
  return manager;
}
