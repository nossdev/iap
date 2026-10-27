import { IAPError, IAPErrorCode } from '../../lib/errors.js';
import type { StorageAdapter } from './types.js';

/** The slice of the plugin this adapter uses. */
type PreferencesPlugin = Pick<
  typeof import('@capacitor/preferences').Preferences,
  'get' | 'set' | 'remove'
>;

/**
 * Storage adapter backed by `@capacitor/preferences`.
 *
 * On iOS/Android, Preferences uses native key-value stores
 * (NSUserDefaults / SharedPreferences). On web it transparently falls
 * back to `localStorage`, which means cached entitlements and
 * unfinished transactions survive page reloads in browser dev too.
 *
 * Keys are prefixed with `${namespace}.` to avoid collisions with other
 * Preferences consumers in the same app.
 *
 * ## Why the plugin is loaded lazily
 *
 * `@capacitor/preferences` is an **optional** peer dependency, and it is
 * reached only through the `await import()` below. A static import would be
 * hoisted into the bundle's top-level imports, so every consumer would ship
 * the native plugin — including one that passes `storage.type: 'custom'` and
 * never touches Preferences at all.
 *
 * Note this is about *bundling*, not resolution. A bundler still resolves a
 * dynamic import at build time — Rollup fails with
 * `failed to resolve import "@capacitor/preferences"` — so an app that
 * actually uninstalls the package has to externalise it. The installation
 * guide carries the config. What the lazy import buys is that the plugin is
 * not pulled into the top-level graph of every consumer that keeps it
 * installed but never selects `storage.type: 'preferences'`.
 *
 * {@link PreferencesAdapter.ensureAvailable} exists so `initialize()` can
 * surface a missing plugin immediately rather than letting it appear as an
 * unreadable cache: the cache read is deliberately tolerant of failure, so
 * without the early check a missing plugin would look like an empty cache
 * and iap would silently persist nothing.
 */
export class PreferencesAdapter implements StorageAdapter {
  private readonly prefix: string;
  private readonly knownKeys = new Set<string>();
  /**
   * Boxed, and that is not incidental — see {@link PreferencesAdapter.preferences}.
   */
  private plugin: Promise<{ preferences: PreferencesPlugin }> | null = null;

  constructor(namespace: string) {
    this.prefix = `${namespace}.`;
  }

  /**
   * The plugin, inside a box.
   *
   * The box is load-bearing. `registerPlugin()` hands back a **Proxy** that
   * answers any property, `then` included — so resolving a promise *with*
   * the plugin makes it look like a thenable, and promise assimilation
   * calls `Preferences.then()`. On web that rejects with
   * `"Preferences.then()" is not implemented on web`, from inside
   * `await this.preferences()`, for every storage operation.
   *
   * Wrapping it in a plain object means the promise resolves with something
   * that has no `then`, so nothing is assimilated.
   */
  private preferences(): Promise<{ preferences: PreferencesPlugin }> {
    this.plugin ??= import('@capacitor/preferences')
      .then((mod) => ({ preferences: mod.Preferences }))
      .catch((cause) => {
        // Two different failures, and conflating them was wrong in both
        // directions: "the package is not installed" is a configuration
        // problem no retry can fix, while "the chunk did not load" is a
        // network problem a retry may well fix. Only the second clears the
        // memo — caching the rejection for the first is what stops every
        // later storage call re-requesting a module that is not there.
        if (isModuleNotFound(cause)) throw notInstalled(cause);
        this.plugin = null;
        throw new IAPError({
          code: IAPErrorCode.STORAGE_ERROR,
          message:
            'Could not load @capacitor/preferences. The package is installed, so this is most likely a chunk that failed to load; it is worth retrying.',
          cause,
          recoverable: true,
        });
      });
    return this.plugin;
  }

  /**
   * Resolve the plugin now, so a missing one is reported at `initialize()`.
   *
   * See the note on lazy loading above for why this is not left to the first
   * `get()`.
   */
  async ensureAvailable(): Promise<void> {
    await this.preferences();
  }

  async get(key: string): Promise<string | null> {
    // Resolved outside the try so its own error survives: a missing plugin
    // is a configuration problem, and re-wrapping it as a transient
    // STORAGE_ERROR is what the recovery loop acts on — it would retry at
    // every launch forever for a cause no retry can fix.
    const { preferences } = await this.preferences();
    try {
      const result = await preferences.get({ key: this.prefix + key });
      return result.value;
    } catch (cause) {
      throw wrap(cause, `Preferences.get failed for "${key}".`);
    }
  }

  async set(key: string, value: string): Promise<void> {
    const { preferences } = await this.preferences();
    try {
      await preferences.set({ key: this.prefix + key, value });
      this.knownKeys.add(key);
    } catch (cause) {
      throw wrap(cause, `Preferences.set failed for "${key}".`);
    }
  }

  async remove(key: string): Promise<void> {
    const { preferences } = await this.preferences();
    try {
      await preferences.remove({ key: this.prefix + key });
      this.knownKeys.delete(key);
    } catch (cause) {
      throw wrap(cause, `Preferences.remove failed for "${key}".`);
    }
  }

  async clear(): Promise<void> {
    const { preferences } = await this.preferences();
    // We can't ask Preferences to clear-by-prefix, so we remove the keys
    // we know about. Phase 2/3/4/6 each only touch a small fixed set.
    const keys = [...this.knownKeys];

    // A key whose removal fails is **kept** in the known set, so a later
    // clear tries it again. `reset()` relies on exactly that: it removes
    // every registry key by name and then calls this, and its comment says
    // the trailing clear gives a failed key a second attempt. Dropping the
    // whole set up front — which this used to do — made that untrue, and
    // left a key on the device that nothing would ever try again.
    const failed: string[] = [];
    const errors: unknown[] = [];
    await Promise.all(
      keys.map(async (key) => {
        try {
          await preferences.remove({ key: this.prefix + key });
          this.knownKeys.delete(key);
        } catch (cause) {
          failed.push(key);
          errors.push(cause);
        }
      }),
    );

    if (failed.length > 0) {
      // Wrapped like every other method, rather than letting a raw plugin
      // rejection escape as something that is not an IAPError.
      throw wrap(errors[0], `Preferences.clear failed for ${failed.length} key(s).`);
    }
  }
}

/**
 * Whether a dynamic-import failure means "not installed" rather than
 * "did not load this time".
 *
 * Node sets a `code`; bundlers and browsers only give a message, and they
 * word it differently, so both are checked.
 *
 * The **`cause` chain** is walked because the error that reaches here is
 * often not the original: module loaders and dev servers wrap it, and the
 * reason only survives one level down. Depth-bounded rather than recursive
 * to the end, since a `cause` chain can be circular.
 */
function isModuleNotFound(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;

    const message = current instanceof Error ? current.message : String(current);
    if (/cannot find (module|package)|could not resolve|failed to resolve/i.test(message)) {
      return true;
    }

    const next = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  return false;
}

function notInstalled(cause: unknown): IAPError {
  return new IAPError({
    code: IAPErrorCode.INVALID_CONFIG,
    message:
      'storage.type is "preferences" (the default) but @capacitor/preferences is not installed. Install it (npm i @capacitor/preferences && npx cap sync), or choose storage that needs no plugin: storage.type "memory", or "custom" with your own adapter.',
    // The per-code hint for INVALID_CONFIG sends the reader to check field
    // paths against the config schema. There are none to check, and no
    // config change fixes this — the message above already says what to do.
    includeHint: false,
    cause,
  });
}

function wrap(cause: unknown, message: string): IAPError {
  return new IAPError({
    code: IAPErrorCode.STORAGE_ERROR,
    message,
    cause,
    recoverable: true,
  });
}
