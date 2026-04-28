/**
 * Minimal key-value storage contract used by the entitlement cache and
 * the unfinished-transactions list. Keys are arbitrary strings; values
 * are serialized JSON strings (cache layer handles the encoding).
 *
 * Implementations: PreferencesAdapter (Capacitor Preferences) and
 * MemoryAdapter (in-memory map; default for tests). Consumers can
 * supply a custom adapter via `config.storage.adapter`.
 */
export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Remove every key the adapter owns. Scoped to the namespace. */
  clear(): Promise<void>;
}
