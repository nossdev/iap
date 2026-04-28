import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory backing store for the mocked Preferences plugin.
const backing = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: backing.has(key) ? (backing.get(key) ?? null) : null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      backing.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      backing.delete(key);
    }),
  },
}));

import { PreferencesAdapter } from '../../src/adapters/storage/preferences-adapter.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';

describe('PreferencesAdapter', () => {
  beforeEach(() => {
    backing.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('namespaces keys with the configured prefix', async () => {
    const adapter = new PreferencesAdapter('nossdev_iap');
    await adapter.set('entitlements', '{"a":1}');
    expect(backing.get('nossdev_iap.entitlements')).toBe('{"a":1}');
  });

  it('returns null for missing keys', async () => {
    const adapter = new PreferencesAdapter('ns');
    expect(await adapter.get('missing')).toBeNull();
  });

  it('roundtrips set/get/remove', async () => {
    const adapter = new PreferencesAdapter('ns');
    await adapter.set('foo', 'bar');
    expect(await adapter.get('foo')).toBe('bar');
    await adapter.remove('foo');
    expect(await adapter.get('foo')).toBeNull();
  });

  it('clear() removes only keys it has set', async () => {
    const adapter = new PreferencesAdapter('ns');
    backing.set('ns.unrelated', 'set-by-someone-else');
    await adapter.set('a', '1');
    await adapter.set('b', '2');
    await adapter.clear();
    expect(await adapter.get('a')).toBeNull();
    expect(await adapter.get('b')).toBeNull();
    // Unrelated key is untouched (we only clear keys we know about).
    expect(backing.get('ns.unrelated')).toBe('set-by-someone-else');
  });

  it('isolates namespaces between adapter instances', async () => {
    const a = new PreferencesAdapter('a_ns');
    const b = new PreferencesAdapter('b_ns');
    await a.set('shared', 'A');
    await b.set('shared', 'B');
    expect(await a.get('shared')).toBe('A');
    expect(await b.get('shared')).toBe('B');
  });

  it('wraps storage errors as IAPError with STORAGE_ERROR code', async () => {
    const { Preferences } = await import('@capacitor/preferences');
    (
      Preferences.get as unknown as { mockRejectedValueOnce: (e: Error) => void }
    ).mockRejectedValueOnce(new Error('native failure'));
    const adapter = new PreferencesAdapter('ns');
    try {
      await adapter.get('foo');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.STORAGE_ERROR);
    }
  });
});
