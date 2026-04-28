import type { StorageAdapter } from './types.js';

/**
 * In-memory storage adapter. Used as the default for tests and on web
 * dev environments where Capacitor Preferences is unnecessary.
 *
 * Each instance owns its own Map — no global state. Namespace prefix is
 * prepended to keys so multiple instances against shared backing storage
 * (e.g., on the same device when used as a fallback) don't collide.
 */
export class MemoryAdapter implements StorageAdapter {
  private readonly store = new Map<string, string>();
  private readonly prefix: string;

  constructor(namespace: string) {
    this.prefix = `${namespace}.`;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(this.prefix + key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(this.prefix + key, value);
  }

  async remove(key: string): Promise<void> {
    this.store.delete(this.prefix + key);
  }

  async clear(): Promise<void> {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(this.prefix)) this.store.delete(key);
    }
  }
}
