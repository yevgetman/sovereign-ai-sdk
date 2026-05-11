// LRU session cache. Maps session keys → active session IDs.
// Evicts the least-recently-used entry when the cache exceeds maxSize.
// A Map preserves insertion order; delete + re-insert on access = O(1) LRU.

export type CacheEntry = {
  readonly sessionId: string;
  readonly lastActive: Date;
};

export class SessionCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly maxSize: number = 32) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    // Refresh LRU position.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  set(key: string, sessionId: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { sessionId, lastActive: new Date() });
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }

  entries(): IterableIterator<[string, CacheEntry]> {
    return this.cache.entries();
  }
}
