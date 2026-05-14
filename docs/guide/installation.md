# Installation

## Requirements

- **Capacitor:** 7.x (also runs on 8.x). For the Capacitor 5 line, install `@nosslabs/iap@latest` (the `5.x` releases) — see [Migration](/migration/).
- **Platform versions:** iOS 15.0+ (StoreKit 2 requirement), Android API 21+ (Google Play Billing 7.x)
- **Node:** 18+ for tooling
- **Backend:** any HTTP/JSON service you control (or a custom [`BackendAdapter`](/api/backend-adapter) for non-HTTP transports)

If your app needs to support iOS < 15, this library is not for you.

## Install the package

```bash
npm install @nosslabs/iap
```

(`@nosslabs/iap@latest` is the `7.x` (Capacitor 7+) line. For Capacitor 5, pin `@nosslabs/iap@^5` — `^5` ranges resolve to the maintenance `5.x` line, not `7.x`.)

## Install the native plugin

`@nosslabs/iap` wraps [`@capgo/native-purchases`](https://github.com/Cap-go/native-purchases) — a free, MIT-licensed, StoreKit 2 / Google Play Billing 7 plugin built as a first-class Capacitor plugin.

```bash
npm install @capgo/native-purchases
npx cap sync
```

On Capacitor 7 install `@capgo/native-purchases@7.16.x`; on Capacitor 8 you can use `@capgo/native-purchases@^8`. `npx cap sync` is required so the iOS and Android native projects pick up the plugin code. Re-run it any time you add/update native dependencies.

::: warning Don't skip `cap sync`
A common cause of purchases silently failing (or `isAvailable()` returning `false`) is forgetting `npx cap sync` after installing `@capgo/native-purchases`. The plugin's native source files don't get linked otherwise.
:::

## Install Capacitor peer dependencies

If you don't already have these installed in your Capacitor 7 app, add them:

```bash
npm install @capacitor/core @capacitor/preferences
npx cap sync
```

`@capacitor/preferences` is what the library uses for the entitlement cache and unfinished-transaction storage. It's backed by `NSUserDefaults` on iOS, `SharedPreferences` on Android, and `localStorage` on web.

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
