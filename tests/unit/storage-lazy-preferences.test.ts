import { describe, expect, it, vi } from 'vitest';

/**
 * `@capacitor/preferences` is an **optional** peer, reached only through a
 * lazy `import()`.
 *
 * A static import would be hoisted into the bundle's top-level imports, so
 * every consumer would ship the native plugin — including one that passes
 * `storage.type: 'custom'` and never touches Preferences.
 *
 * The plugin is mocked here to **throw on load**, which is what an
 * uninstalled one does. That makes the guarantee a hard one rather than a
 * counted one: if any of the no-plugin configs below reached the module, it
 * would fail outright rather than quietly incrementing a tally. It also
 * means this file doubles as the missing-plugin contract.
 *
 * Why not a load counter: the module registry caches a module per test
 * *file*, so a factory runs at most once no matter how many tests ask for
 * it — a per-test counter reads 0 for every test after the first, and a
 * per-test "now make it fail" flag never takes effect at all.
 *
 * The happy path, through the same lazy load, is `preferences-adapter.test.ts`.
 */
vi.mock('@capacitor/preferences', () => {
  throw new Error("Cannot find module '@capacitor/preferences'");
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false },
}));

vi.mock('../../src/core/app-resume-listener.js', () => ({
  attachAppResumeListener: vi.fn(async () => null),
}));

import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';
import { PreferencesAdapter } from '../../src/adapters/storage/preferences-adapter.js';
import { createIAP } from '../../src/createIAP.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import type { IAPConfigInput } from '../../src/types/config.js';

const base = {
  products: [{ id: 'household_yearly', type: 'subscription' }],
  verification: { mode: 'local', entitlements: () => [] },
  options: { logLevel: 'silent', refreshOnResume: false },
};

function config(storage: IAPConfigInput['storage']): IAPConfigInput {
  return { ...base, storage } as IAPConfigInput;
}

describe('storage that needs no plugin', () => {
  it('works with a custom adapter and no @capacitor/preferences installed', async () => {
    const iap = createIAP(
      config({ type: 'custom', namespace: 'test', adapter: new MemoryAdapter('test') }),
    );

    // The whole point of the optional peer: a consumer with their own
    // storage should neither need the native plugin nor ship it.
    await expect(iap.initialize()).resolves.toBeUndefined();
    await expect(iap.refresh()).resolves.toBeUndefined();
    expect(iap.getEntitlements()).toEqual([]);
  });

  it('works with the memory adapter and no @capacitor/preferences installed', async () => {
    const iap = createIAP(config({ type: 'memory', namespace: 'test' }));

    await expect(iap.initialize()).resolves.toBeUndefined();
    await expect(iap.refresh()).resolves.toBeUndefined();
  });

  it('persists through a custom adapter without touching the plugin', async () => {
    const storage = new MemoryAdapter('test');
    const iap = createIAP(config({ type: 'custom', namespace: 'test', adapter: storage }));
    await iap.initialize();
    await iap.refresh();

    // Reaching storage for real, not just constructing it — a write is
    // where a static import would have been needed.
    await storage.set('probe', 'written');
    expect(await storage.get('probe')).toBe('written');
  });
});

describe('preferences chosen but not installed', () => {
  it('fails at initialize() with INVALID_CONFIG, not as an empty cache', async () => {
    const iap = createIAP(config({ type: 'preferences', namespace: 'test' }));

    // Reported here rather than at the first cache read, because that read
    // treats any failure as "nothing cached" — so a missing plugin would
    // look like a cold start and iap would silently persist nothing.
    //
    // This is also the positive control for the tests above: it only fails
    // if the mocked module really is what the adapter reaches.
    const error = await iap.initialize().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IAPError);
    expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_CONFIG);
  });

  it('fails the same way for the default storage config, which is preferences', async () => {
    const iap = createIAP(base as IAPConfigInput);

    const error = await iap.initialize().catch((e: unknown) => e);

    expect((error as IAPError).code).toBe(IAPErrorCode.INVALID_CONFIG);
  });

  it('says what to install, and what the alternatives are', async () => {
    const adapter = new PreferencesAdapter('test');

    const error = (await adapter.get('entitlements').catch((e: unknown) => e)) as IAPError;

    expect(error.message).toContain('npm i @capacitor/preferences');
    // And the two ways out that need no plugin at all, since for some
    // consumers that is the better answer.
    expect(error.message).toContain('memory');
    expect(error.message).toContain('custom');
  });

  it('keeps the configuration error rather than re-wrapping it as transient', async () => {
    const adapter = new PreferencesAdapter('test');

    const error = (await adapter.set('k', 'v').catch((e: unknown) => e)) as IAPError;

    // A STORAGE_ERROR is `recoverable`, so the recovery loop would retry it
    // at every launch forever. An uninstalled plugin is not transient, and
    // this is why the load is resolved outside each method's try/catch.
    expect(error.code).toBe(IAPErrorCode.INVALID_CONFIG);
    expect(error.recoverable).toBe(false);
  });

  it('does not append the INVALID_CONFIG hint, which points at the wrong thing', async () => {
    const adapter = new PreferencesAdapter('test');

    const error = (await adapter.get('k').catch((e: unknown) => e)) as IAPError;

    // That hint tells the reader to check field paths against the config
    // schema. There are none, and no config change fixes an uninstalled
    // package — the message already says what to do.
    expect(error.message).not.toContain('field paths');
  });

  it('survives the error being wrapped by a loader', async () => {
    // What actually reaches the adapter: module loaders and dev servers
    // wrap the original and leave the reason one level down in `cause`.
    // This is the harness's own behaviour too, which is why these tests
    // exercise it rather than a bare error.
    const adapter = new PreferencesAdapter('test');
    const error = (await adapter.get('k').catch((e: unknown) => e)) as IAPError;

    expect(error.code).toBe(IAPErrorCode.INVALID_CONFIG);
  });

  it('keeps erasing honest: reset() refuses rather than reporting a false success', async () => {
    const iap = createIAP(config({ type: 'preferences', namespace: 'test' }));

    // Every step of `reset()` is swallow-and-warn, which is right for one
    // key that will not delete. But an adapter that can reach *nothing*
    // would resolve normally having deleted nothing — and for a "delete
    // everything" control, telling the caller their data is gone while it
    // is still on the device is the one outcome worth throwing over.
    await expect(iap.reset()).rejects.toBeInstanceOf(IAPError);
  });

  it('reports it from every method, not only the first one called', async () => {
    const adapter = new PreferencesAdapter('test');

    for (const call of [
      () => adapter.get('k'),
      () => adapter.set('k', 'v'),
      () => adapter.remove('k'),
      () => adapter.clear(),
    ]) {
      const error = (await call().catch((e: unknown) => e)) as IAPError;
      expect(error).toBeInstanceOf(IAPError);
      expect(error.code).toBe(IAPErrorCode.INVALID_CONFIG);
    }
  });
});

/**
 * Globbed as text, because the runtime tests above cannot see the
 * difference that matters to a *bundler*: a static
 * `import { Preferences } from '@capacitor/preferences'` behaves identically
 * at runtime but is hoisted into the bundle's top-level imports, which is
 * exactly the regression this change fixes.
 */
const sources = import.meta.glob<string>('../../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('the plugin is reachable only through a dynamic import', () => {
  it('globs every source, so the sweep below is not vacuous', () => {
    const paths = Object.keys(sources);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.some((path) => path.endsWith('/storage/preferences-adapter.ts'))).toBe(true);
  });

  it('is imported from exactly one module, the adapter', () => {
    // Any reference that is part of an import — dynamic or static — not
    // merely prose naming the package in a comment.
    const importing = Object.entries(sources)
      .filter(([, source]) => /import\s*\(\s*['"`]@capacitor\/preferences/.test(source))
      .map(([path]) => path);

    expect(importing).toHaveLength(1);
    expect(importing[0]).toMatch(/preferences-adapter\.ts$/);
  });

  it('is never named in a static import or require', () => {
    const offenders: string[] = [];

    for (const [path, source] of Object.entries(sources)) {
      for (const line of source.split('\n')) {
        if (!line.includes('@capacitor/preferences')) continue;
        // `await import('…')` and the `typeof import('…')` type are both
        // fine; `import … from '…'` and `require('…')` are not.
        if (/^\s*import\s[^(]*from\s/.test(line)) offenders.push(`${path}: ${line.trim()}`);
        if (/require\(/.test(line)) offenders.push(`${path}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
