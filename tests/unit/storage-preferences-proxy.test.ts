import { describe, expect, it, vi } from 'vitest';

/**
 * The plugin Capacitor actually hands over is a **Proxy**, not a plain
 * object, and `registerPlugin()` makes it answer *any* property — `then`
 * included.
 *
 * That matters because the adapter reaches the plugin through a promise now.
 * Resolving a promise with a thenable assimilates it: the runtime sees
 * `.then`, calls it, and on web Capacitor answers
 * `"Preferences.then()" is not implemented on web` — which surfaced as every
 * storage operation hanging, then timing out.
 *
 * So this mocks the shape faithfully rather than conveniently: a backing
 * store behind a Proxy whose `get` answers everything.
 */
const backing = new Map<string, string>();

/** Exposed so a test can make one `remove` fail. */
const real: Record<string, unknown> = vi.hoisted(() => ({})) as Record<string, unknown>;

vi.mock('@capacitor/preferences', () => {
  Object.assign(real, {
    get: async ({ key }: { key: string }) => ({ value: backing.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      backing.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      backing.delete(key);
    },
  });

  return {
    Preferences: new Proxy(real, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        // What registerPlugin does for anything it does not implement —
        // including `then`, which is the whole point of this file.
        return () => {
          throw new Error(`"Preferences.${String(prop)}()" is not implemented on web`);
        };
      },
      has: () => true,
    }),
  };
});

import { PreferencesAdapter } from '../../src/adapters/storage/preferences-adapter.js';
import { IAPError } from '../../src/lib/errors.js';

describe('PreferencesAdapter against a plugin proxy', () => {
  it('does not let the proxy be assimilated as a thenable', async () => {
    backing.clear();
    const adapter = new PreferencesAdapter('ns');

    // Each of these awaits the boxed plugin. Without the box, promise
    // resolution would call the proxy's `then` and every one would reject.
    await adapter.set('entitlements', '{"a":1}');
    expect(await adapter.get('entitlements')).toBe('{"a":1}');
    await adapter.remove('entitlements');
    expect(await adapter.get('entitlements')).toBeNull();
    await expect(adapter.clear()).resolves.toBeUndefined();
  });

  it('boxes the plugin on the ensureAvailable path too', async () => {
    const adapter = new PreferencesAdapter('ns');

    // The readiness probe resolves the same promise. A refactor that
    // returned the plugin unboxed from only this method would otherwise
    // slip past the test above.
    await expect(adapter.ensureAvailable()).resolves.toBeUndefined();
  });

  it('resolves the plugin once and shares it across parallel calls', async () => {
    backing.clear();
    const adapter = new PreferencesAdapter('ns');

    // `??=` assigns the promise synchronously, before the first await
    // yields, so two concurrent calls share one load rather than racing
    // to start two.
    const first = adapter.get('k');
    const second = adapter.get('k');
    const plugin = (adapter as unknown as { plugin: unknown }).plugin;

    await Promise.all([first, second]);
    expect((adapter as unknown as { plugin: unknown }).plugin).toBe(plugin);
  });

  it('keeps a key whose removal failed, so a later clear retries it', async () => {
    backing.clear();
    const adapter = new PreferencesAdapter('ns');
    await adapter.set('good', '1');
    await adapter.set('bad', '2');

    let failNext = true;
    const original = real.remove as (o: { key: string }) => Promise<void>;
    real.remove = async (o: { key: string }) => {
      if (failNext && o.key.endsWith('bad')) throw new Error('remove failed');
      await original(o);
    };

    // `reset()` removes every registry key by name and then calls clear(),
    // and its comment says that trailing clear gives a failed key a second
    // attempt. Dropping the whole known set up front made that untrue and
    // left the key on the device with nothing to try it again.
    await expect(adapter.clear()).rejects.toBeInstanceOf(IAPError);
    expect([...backing.keys()]).toEqual(['ns.bad']);

    failNext = false;
    await expect(adapter.clear()).resolves.toBeUndefined();
    expect([...backing.keys()]).toEqual([]);
    real.remove = original;
  });

  it('still clears the keys it has seen', async () => {
    backing.clear();
    const adapter = new PreferencesAdapter('ns');
    await adapter.set('a', '1');
    await adapter.set('b', '2');

    await adapter.clear();

    expect([...backing.keys()]).toEqual([]);
  });
});
