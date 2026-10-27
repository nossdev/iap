import { describe, expect, it } from 'vitest';
import { ALL_IAP_STORAGE_KEYS, IAP_STORAGE_KEYS } from '../../src/core/storage-keys.js';

/**
 * The registry exists so `reset()` cannot miss a key. That only holds if the
 * registry is complete, so the guard here is not "do the known keys appear"
 * — which the registry makes true by construction — but "does any module
 * reach storage with a key the registry has never heard of".
 *
 * Globs the sources rather than naming the modules, because the regression
 * being guarded against is a *new* module: one named in a list here would be
 * one someone had already remembered.
 */
const sources = import.meta.glob<string>('../../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * A storage call whose key is written inline: `storage.get('entitlements')`.
 *
 * Anchored on `storage` rather than on the key, so it flags a key the
 * registry has never heard of — which is the whole regression. Matching on
 * the three known key strings instead could only ever catch a duplicate of
 * something already registered.
 */
const INLINE_KEY = /\bstorage\.(?:get|set|remove)\(\s*(['"`])([^'"`]*)\1/g;

describe('IAP_STORAGE_KEYS', () => {
  it('names the three keys iap owns', () => {
    expect(ALL_IAP_STORAGE_KEYS).toEqual([
      'entitlements',
      'unfinished_transactions',
      'pending_purchases',
    ]);
  });

  it('has no duplicate values', () => {
    expect(new Set(ALL_IAP_STORAGE_KEYS).size).toBe(ALL_IAP_STORAGE_KEYS.length);
  });

  it('is frozen, so nothing can shrink what reset() erases', () => {
    expect(Object.isFrozen(ALL_IAP_STORAGE_KEYS)).toBe(true);
  });

  it('globs every source, so a new module cannot escape the sweep below', () => {
    // Guards the guard: a glob that silently matched nothing would make the
    // next test pass for the wrong reason.
    const paths = Object.keys(sources);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.some((path) => path.endsWith('/core/reset.ts'))).toBe(true);
  });

  it('is the only source of a key any module hands to storage', () => {
    // The regression: a store added later that writes its own key instead
    // of registering one. `reset()` would not know to clear it, so it would
    // survive a "delete everything" control — and a test that named today's
    // three modules, or scanned for today's three key strings, could never
    // see it, because neither the module nor the key would be in either
    // list.
    //
    // So the rule is positional, not value-based: **no** storage call
    // anywhere takes an inline key. Every one names a registry constant.
    const offenders: string[] = [];

    for (const [path, source] of Object.entries(sources)) {
      for (const [, , key] of source.matchAll(INLINE_KEY)) {
        const known = ALL_IAP_STORAGE_KEYS.includes(key as never);
        offenders.push(
          `${path} hardcodes the storage key "${key}"${
            known ? '' : ', which is not in the registry — reset() will not clear it'
          }`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every store takes its key from the registry', () => {
    // The other half: the three stores must *reference* the registry, so a
    // key moved out of it cannot be reintroduced as a local constant with a
    // different spelling (which the sweep above would not recognise).
    const stores = [
      '/core/entitlement-cache.ts',
      '/core/unfinished-transactions.ts',
      '/core/pending-purchases.ts',
    ];

    for (const suffix of stores) {
      const entry = Object.entries(sources).find(([path]) => path.endsWith(suffix));
      expect(entry, `${suffix} should be globbed`).toBeDefined();
      expect(entry?.[1], `${suffix} should import its key from the registry`).toMatch(
        /import\s*\{[^}]*IAP_STORAGE_KEYS/,
      );
    }
  });

  it('keys the registry by a stable name, so reset() reads it structurally', () => {
    expect(Object.keys(IAP_STORAGE_KEYS).sort()).toEqual([
      'entitlements',
      'pendingPurchases',
      'unfinishedTransactions',
    ]);
  });
});
