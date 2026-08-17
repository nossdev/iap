# Installation

## Requirements

- **Capacitor:** 7.x. For the Capacitor 8 line, see the release candidate below. For the Capacitor 5 line, install `@nosslabs/iap@^5` (the `5.x` releases) — see [Migration](/migration/).
- **Platform versions:** iOS 15.0+ (StoreKit 2 requirement). Android API 21+ on the `7.x` line (Google Play Billing 7.x); **API 24+** on the `8.x` line, which ships Google Play Billing 8.x.
- **Node:** 18+ for tooling on the `7.x` line; Capacitor 8 requires **Node 22+**.
- **Backend:** any HTTP/JSON service you control (or a custom [`BackendAdapter`](/api/backend-adapter) for non-HTTP transports)

If your app needs to support iOS < 15, this library is not for you.

## Install the package

```bash
npm install @nosslabs/iap
```

(`@nosslabs/iap@latest` is the `7.x` (Capacitor 7) line, also reachable as `@latest-7`. For Capacitor 5, pin `@nosslabs/iap@^5` — `^5` ranges resolve to the maintenance `5.x` line, not `7.x`.)

::: tip Capacitor 8
The Capacitor 8 line is in release candidate on the `@next` dist-tag:

```bash
npm install @nosslabs/iap@next @capgo/native-purchases@^8
```

`@latest` stays on the `7.x` line until it graduates. Substitute `^8` for
`lts-v7`, and `@capacitor/*@^8` for `@capacitor/*@^7`, everywhere below — the
library's own API is identical on both lines. See [Migration](/migration/).
:::

## Install the native plugin

`@nosslabs/iap` wraps [`@capgo/native-purchases`](https://github.com/Cap-go/native-purchases) — a free, MIT-licensed, StoreKit 2 / Google Play Billing plugin built as a first-class Capacitor plugin. (Play Billing 7.x on the `lts-v7` line, 8.x on the `^8` line.)

```bash
npm install @capgo/native-purchases@lts-v7
npx cap sync
```

Pin the dist-tag rather than installing bare: npm's `latest` for that plugin now points at its 8.x (Capacitor 8) line, so an unqualified `npm install @capgo/native-purchases` in a Capacitor 7 app pulls a version that requires Capacitor 8. Use `@lts-v7` on Capacitor 7 and `@^8` on Capacitor 8.

`npx cap sync` is required so the iOS and Android native projects pick up the plugin code. Re-run it any time you add/update native dependencies.

::: warning Don't skip `cap sync`
A common cause of purchases silently failing (or `isAvailable()` returning `false`) is forgetting `npx cap sync` after installing `@capgo/native-purchases`. The plugin's native source files don't get linked otherwise.
:::

## Install Capacitor peer dependencies

If you don't already have these installed, add them — matching your Capacitor major:

```bash
# Capacitor 7
npm install @capacitor/core@^7 @capacitor/preferences@^7

# Capacitor 8
npm install @capacitor/core@^8 @capacitor/preferences@^8

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
