import { Preferences } from '@capacitor/preferences';
import { IAPError, IAPErrorCode } from '../../lib/errors.js';
import type { StorageAdapter } from './types.js';

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
 */
export class PreferencesAdapter implements StorageAdapter {
  private readonly prefix: string;
  private readonly knownKeys = new Set<string>();

  constructor(namespace: string) {
    this.prefix = `${namespace}.`;
  }

  async get(key: string): Promise<string | null> {
    try {
      const result = await Preferences.get({ key: this.prefix + key });
      return result.value;
    } catch (cause) {
      throw wrap(cause, `Preferences.get failed for "${key}".`);
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await Preferences.set({ key: this.prefix + key, value });
      this.knownKeys.add(key);
    } catch (cause) {
      throw wrap(cause, `Preferences.set failed for "${key}".`);
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await Preferences.remove({ key: this.prefix + key });
      this.knownKeys.delete(key);
    } catch (cause) {
      throw wrap(cause, `Preferences.remove failed for "${key}".`);
    }
  }

  async clear(): Promise<void> {
    // We can't ask Preferences to clear-by-prefix, so we remove the keys
    // we know about. Phase 2/3/4/6 each only touch a small fixed set.
    const keys = [...this.knownKeys];
    this.knownKeys.clear();
    await Promise.all(keys.map((k) => Preferences.remove({ key: this.prefix + k })));
  }
}

function wrap(cause: unknown, message: string): IAPError {
  return new IAPError({
    code: IAPErrorCode.STORAGE_ERROR,
    message,
    cause,
    recoverable: true,
  });
}
