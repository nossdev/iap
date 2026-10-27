# Installation

## Requirements

- **Capacitor:** 8.x. For the Capacitor 7 line, install `@nosslabs/iap@^7` — see the [v7 docs](/v7/). For the Capacitor 5 line, install `@nosslabs/iap@^5` — see the [v5 docs](/v5/) and [Migration](/migration/).
- **Platform versions:** iOS 15.0+ (StoreKit 2 requirement). Android **API 24+** (Capacitor 8's minimum; the line ships Google Play Billing 8.x).
- **Node:** 22+ (required by Capacitor 8).
- **Backend:** any HTTP/JSON service you control (or a custom [`BackendAdapter`](/api/backend-adapter) for non-HTTP transports)

If your app needs to support iOS < 15, this library is not for you.

## Install the package

```bash
npm install @nosslabs/iap
```

(`@nosslabs/iap@latest` is the `8.x` (Capacitor 8) line, also reachable as `@latest-8`. For Capacitor 7, pin `@nosslabs/iap@^7` — `^7` ranges resolve to the maintenance `7.x` line, not `8.x`. For Capacitor 5, pin `@nosslabs/iap@^5`.)

::: tip Still on Capacitor 7?
The `7.x` line stays supported on `@latest-7`:

```bash
npm install @nosslabs/iap@^7 @capgo/native-purchases@lts-v7
```

Below, use `@capgo/native-purchases@lts-v7` in place of the bare plugin
install, and `@capacitor/*@^7` in place of `@capacitor/*@^8` — the library's
own API is identical on both lines. Full instructions live in the
[v7 docs](/v7/guide/installation).
:::

## Install the native plugin

`@nosslabs/iap` wraps [`@capgo/native-purchases`](https://github.com/Cap-go/capacitor-native-purchases) — a free, **MPL-2.0-licensed**, StoreKit 2 / Google Play Billing plugin built as a first-class Capacitor plugin. (Play Billing 8.x on the `8.x` line; 7.x on the `lts-v7` line.) iap uses it unmodified, so MPL's file-level copyleft imposes no obligation on your source — see [The native layer](/guide/native-layer) for the licence note, the Play Billing version and the device-identifier audit.

```bash
npm install @capgo/native-purchases
npx cap sync
```

On Capacitor 8 the plugin's default `latest` tag is correct. On **Capacitor 7**, pin `@lts-v7` instead — `latest` points at the 8.x line, which requires Capacitor 8.

`npx cap sync` is required so the iOS and Android native projects pick up the plugin code. Re-run it any time you add/update native dependencies.

::: warning Don't skip `cap sync`
A common cause of purchases silently failing (or `isAvailable()` returning `false`) is forgetting `npx cap sync` after installing `@capgo/native-purchases`. The plugin's native source files don't get linked otherwise.
:::

## Install Capacitor peer dependencies

If you don't already have these installed, add them — matching your Capacitor major:

```bash
npm install @capacitor/core@^8 @capacitor/preferences@^8
npx cap sync
```

(On the `7.x` line, use `@^7` for both — see the [v7 docs](/v7/guide/installation).)

`@capacitor/preferences` is what the library uses for the entitlement cache and
unfinished-transaction storage, under the default `storage.type: 'preferences'`. It's backed by
`NSUserDefaults` on iOS, `SharedPreferences` on Android, and `localStorage` on web.

::: tip `@capacitor/preferences` is optional if you bring your own storage
It is an **optional** peer, and iap reaches it through a lazy `import()` — so an app that sets
`storage.type` to `'custom'` (your own adapter) or `'memory'` never loads it, and the native
plugin stays out of the bundle.

**If you uninstall it, tell your bundler.** A dynamic `import()` is still resolved at *build*
time, so Rollup/Vite fails with `Rollup failed to resolve import "@capacitor/preferences"`
unless you externalise it. The import is never evaluated in this configuration, so
externalising it is safe:

```ts
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      // Only if you have uninstalled these optional peers.
      external: ['@capacitor/preferences'],
    },
  },
});
```

The same applies to `@capacitor/app` when `options.refreshOnResume` is `false`. Keeping the
packages installed needs no configuration at all — this is only for dropping them.

Choosing `'preferences'` without it installed fails at `initialize()` with `INVALID_CONFIG`
rather than silently persisting nothing, and the message says what to install.
:::

::: warning If you never declared it yourself
npm 7+ installs a *required* peer into your tree without it appearing in your
`package.json`. Now that this one is optional, a fresh `npm install` or a regenerated lockfile
can drop it — and with it `npx cap sync`'s view of the plugin. If you use the default
`storage.type: 'preferences'`, add `@capacitor/preferences` to your own `dependencies` rather
than relying on it arriving transitively.
:::

## Optional: app-resume listener

By default, `@nosslabs/iap` automatically calls `iap.refresh()` whenever the app returns from background. This catches subscription changes that happened server-side (renewals, billing retries, refunds via Attesto webhooks) without the user pulling-to-refresh.

To enable it, install `@capacitor/app`:

```bash
npm install @capacitor/app
npx cap sync
```

If you don't want this behavior, set `options.refreshOnResume: false` in your config and skip the install.

::: tip Optional peer dep
`@capacitor/app` is declared as `peerDependenciesMeta.optional: true` in `@nosslabs/iap`'s `package.json`. npm won't complain if you skip it. The library detects its absence at runtime and logs a debug-level note instead of crashing.
:::

## Web platform note

`@capgo/native-purchases` is iOS/Android only. On web:

- `iap.purchase()` and `iap.restorePurchases()` reject with `IAPError(PLATFORM_NOT_SUPPORTED)`
- `iap.getProducts()` returns `[]`
- All cached entitlement reads still work (entitlements are persisted via `@capacitor/preferences` which falls back to `localStorage` on web)
- `iap.refresh()` works (it's a plain HTTP call)

This means you can develop your UI in a browser without crashes, and entitlement-gated UI will render correctly based on cached state from a previous mobile session — useful for development workflows.

## Android `MainActivity` launch mode

Set your `MainActivity`'s launch mode to `standard` or `singleTop`:

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<activity
  android:name=".MainActivity"
  android:launchMode="standard"
  ...
>
```

Otherwise the purchase flow can be cancelled when the user backgrounds the app to verify a card in their banking app — Google Play Billing requires the activity to be the foreground task when the purchase resumes.

## Verify the install

Create a tiny script to confirm everything resolves:

```typescript
// scripts/check-iap-install.ts
import { createIAP } from '@nosslabs/iap';

const iap = createIAP({
  products: [{ id: 'test', type: 'product' }],
  backend: {
    baseUrl: 'https://example.com',
    endpoints: {
      verifyApple: '/x',
      verifyGoogle: '/x',
      entitlements: '/x',
      restore: '/x',
    },
    getAuthHeaders: () => ({}),
  },
});

console.log('createIAP factory works.');
```

Run with `tsx scripts/check-iap-install.ts` or similar. No errors → install is healthy.

## Next

- [Configuration](/guide/configuration) — full options reference
- [Getting started](/guide/getting-started) — first purchase walkthrough
