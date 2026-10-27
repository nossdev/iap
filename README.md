# @nosslabs/iap

> Thin Capacitor IAP orchestrator. Server-side validation via [Attesto](https://attesto.nossdev.com).

**Status: `8.0.0` — the Capacitor 8 line, on `@latest`** (built on `@capgo/native-purchases@^8`). The Capacitor 7 line continues in maintenance as `7.x` (pin `^7`, or the `@latest-7` dist-tag — [v7 docs](https://iap.nossdev.com/v7/)) and the Capacitor 5 line (`cordova-plugin-purchase`) as `5.x` (pin `^5` — [v5 docs](https://iap.nossdev.com/v5/)). `^7` and `^5` ranges resolve to their own lines and never cross-resolve. See the [CHANGELOG](./CHANGELOG.md) for the `8.0.0` delta and [Migration](https://iap.nossdev.com/migration/).

```bash
# Capacitor 8 — the current @latest line
npm install @nosslabs/iap @capgo/native-purchases

# Capacitor 7 — maintenance; both pins are required
npm install @nosslabs/iap@^7 @capgo/native-purchases@lts-v7

npx cap sync
```

```typescript
import { createIAP } from '@nosslabs/iap';

const iap = createIAP({
  products: [
    { id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly-plan' },
  ],
  backend: {
    baseUrl: 'https://api.your-app.com',
    endpoints: {
      verifyApple: '/api/iap/verify/apple',
      verifyGoogle: '/api/iap/verify/google',
      entitlements: '/api/iap/entitlements',
      restore: '/api/iap/restore',
    },
    getAuthHeaders: async () => ({
      Authorization: `Bearer ${await getAuthToken()}`,
    }),
  },
});

await iap.initialize();

const result = await iap.purchase({ productId: 'premium_monthly' });
if (result.status === 'success') {
  // backend has validated; entitlements are cached
}

// (optional) Pre-attach a UUID so it travels through StoreKit/Play Billing
// and reaches your backend on both the verify response and the eventual
// webhook — eliminates the verify/webhook race for purchases where the
// user is signed in. Either pass a string you already have or an async
// fetcher that hits your backend (which mints+saves on first call,
// returns the existing UUID on subsequent calls).
await iap.purchase({
  productId: 'premium_monthly',
  appUserId: async () => {
    const r = await fetch('/api/iap/uuid', { method: 'POST', headers: authHeaders() });
    return (await r.json()).uuid;
  },
});
```

## Documentation

**📘 [iap.nossdev.com](https://iap.nossdev.com)** — installation, configuration, framework recipes, API reference.

- [Getting started](https://iap.nossdev.com/guide/getting-started) — first purchase in 30 minutes
- [Backend contract](https://iap.nossdev.com/guide/backend-contract) — four endpoints your backend implements
- [Architecture](https://iap.nossdev.com/guide/architecture) — three-tier model
- [The native layer](https://iap.nossdev.com/guide/native-layer) — what `@capgo/native-purchases` exposes, its licence, its privacy audit
- [Offline and no-backend use](https://iap.nossdev.com/guide/offline-and-no-backend) — on-device verification, offline guarantees, privacy
- [Vue + Quasar recipe](https://iap.nossdev.com/recipes/vue-quasar) / [React recipe](https://iap.nossdev.com/recipes/react)

## Why this library

`@nosslabs/iap` does **one thing**: orchestrate the purchase flow on the client. It

- wraps [`@capgo/native-purchases`](https://github.com/Cap-go/native-purchases) for native purchase + restore,
- POSTs to **your** backend (which calls Attesto) for receipt validation — or [verifies on the device](https://iap.nossdev.com/guide/offline-and-no-backend) when you have no backend at all,
- acknowledges native transactions only **after** the backend confirms — `autoAcknowledgePurchases: false` defers finishing on **both** iOS and Android, so there's no phantom grant and no iOS finish-before-verify race,
- caches entitlements locally for instant, reactive UI reads,
- recovers unfinished transactions across app launches.

It does **not**: talk to Attesto directly, manage user auth, or ship paywall UI. Those belong to your app and your backend. It does not define entitlement business logic either — except in local mode, where you supply the mapping in config because there is no backend to ask.

## Capacitor support matrix

| `@nosslabs/iap` | Capacitor | Native plugin | dist-tag | Status |
|---|---|---|---|---|
| 8.x | 8.x | `@capgo/native-purchases ^8.2` | `@latest`, `@latest-8` | **Current** — `8.2.0` |
| 7.x | 7.x | `@capgo/native-purchases@lts-v7` | `@latest-7` (pin via `^7`) | Maintenance |
| 5.x | 5.x | `cordova-plugin-purchase ^13.x` | `@latest-5` (pin via `^5`) | Maintenance |

## Optional peer dependencies

Both are reached through a lazy `import()`, so an app that does not use them never loads them
and keeps them out of its bundle. If you *uninstall* one, externalise it in your bundler
(`build.rollupOptions.external` in Vite) — a dynamic import is still resolved at build time.
See the [installation guide](https://iap.nossdev.com/guide/installation).

**`@capacitor/app`** — auto-refresh on app resume (the default behaviour):

```bash
npm install @capacitor/app
npx cap sync
```

Or disable the listener with `options.refreshOnResume: false`.

**`@capacitor/preferences`** — the entitlement cache and unfinished-transaction storage, under
the default `storage.type: 'preferences'`:

```bash
npm install @capacitor/preferences
npx cap sync
```

Skip it if you set `storage.type` to `'custom'` (your own adapter) or `'memory'`. Choosing
`'preferences'` without it fails at `initialize()` with a message saying so, rather than
silently persisting nothing.

If you use the default `'preferences'` and never declared the package yourself, add it to your
`dependencies` now: npm installed it for you while it was a *required* peer, and that will stop
happening.

## Development

```bash
mise install        # Node 22 + npm 11 (pinned in mise.toml)
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm test            # vitest run
npm run build       # tsup → dist/index.{js,cjs,d.ts}
npm run docs:dev    # vitepress dev (http://localhost:5173)
```

## License

MIT — see [LICENSE](./LICENSE).

The native layer, [`@capgo/native-purchases`](https://github.com/Cap-go/capacitor-native-purchases),
is **MPL-2.0** and is used **unmodified**, so its file-level copyleft imposes no obligation on
iap or on your app's source. [The native layer](https://iap.nossdev.com/guide/native-layer)
has the full note, with the Play Billing version and the device-identifier audit.
