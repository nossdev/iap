import { IAPError, IAPErrorCode } from '../../lib/errors.js';
import type { StorageConfig } from '../../types/config.js';
import { MemoryAdapter } from './memory-adapter.js';
import { PreferencesAdapter } from './preferences-adapter.js';
import type { StorageAdapter } from './types.js';

/**
 * Build the storage adapter for the configured `storage.type`.
 *
 * - `'preferences'` → Capacitor Preferences (native + localStorage on web)
 * - `'memory'` → in-memory map (tests, ephemeral environments)
 * - `'custom'` → user-supplied adapter via `storage.adapter`
 */
export function selectStorageAdapter(config: StorageConfig): StorageAdapter {
  if (config.type === 'memory') {
    return new MemoryAdapter(config.namespace);
  }
  if (config.type === 'custom') {
    if (!isStorageAdapter(config.adapter)) {
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message:
          'storage.type is "custom" but storage.adapter is missing or does not implement StorageAdapter.',
      });
    }
    return config.adapter;
  }
  return new PreferencesAdapter(config.namespace);
}

function isStorageAdapter(value: unknown): value is StorageAdapter {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StorageAdapter>;
  return (
    typeof candidate.get === 'function' &&
    typeof candidate.set === 'function' &&
    typeof candidate.remove === 'function' &&
    typeof candidate.clear === 'function'
  );
}

export { MemoryAdapter, PreferencesAdapter };
export type { StorageAdapter } from './types.js';
