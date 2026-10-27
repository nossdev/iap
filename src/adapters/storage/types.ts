/**
 * Minimal key-value storage contract used by the entitlement cache and
 * the unfinished-transactions list. Keys are arbitrary strings; values
 * are serialized JSON strings (cache layer handles the encoding).
 *
 * Implementations: PreferencesAdapter (Capacitor Preferences) and
 * MemoryAdapter (in-memory map; default for tests). Consumers can
 * supply a custom adapter via `config.storage.adapter`.
 *
 * Every method is async, which is what lets `PreferencesAdapter` reach its
 * plugin through a lazy `import()` rather than a static one.
 */
export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Remove every key the adapter owns. Scoped to the namespace. */
  clear(): Promise<void>;

  /**
   * Optional: resolve anything the adapter loads lazily, so a missing
   * dependency is reported at `initialize()` instead of surfacing later as
   * a storage failure.
   *
   * `initialize()` awaits this and lets it throw. It exists because the
   * paths that read storage are deliberately tolerant — a corrupt or
   * unreadable cache is treated as empty rather than fatal — so a hard
   * failure like "the plugin is not installed" would otherwise be
   * indistinguishable from "nothing cached yet", and iap would silently
   * persist nothing. {@link PreferencesAdapter} implements it; a custom
   * adapter may, and omitting it means "always ready".
   */
  ensureAvailable?(): Promise<void>;
}
