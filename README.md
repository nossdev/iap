# @nosslabs/iap

> Thin Capacitor IAP orchestrator. Server-side validation via [Attesto](https://attesto.nossdev.com).

**Status: 0.2.0 — published.** API may have breaking changes through the 0.x line as it's exercised in production apps. Pin the minor version (`^0.2.0`) and watch the [CHANGELOG](./CHANGELOG.md).

```bash
npm install @nosslabs/iap cordova-plugin-purchase
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
- [Vue + Quasar recipe](https://iap.nossdev.com/recipes/vue-quasar) / [React recipe](https://iap.nossdev.com/recipes/react)

## Why this library

`@nosslabs/iap` does **one thing**: orchestrate the purchase flow on the client. It

- wraps `cordova-plugin-purchase` for native purchase + restore,
- POSTs to **your** backend (which calls Attesto) for receipt validation,
- acknowledges native transactions only **after** the backend confirms (no phantom grants),
- caches entitlements locally for instant, reactive UI reads,
- recovers unfinished transactions across app launches.

It does **not**: talk to Attesto directly, define entitlement business logic, manage user auth, or ship paywall UI. Those belong to your app and your backend.

## Capacitor support matrix

| `@nosslabs/iap` | Capacitor | Plugin | Status |
|---|---|---|---|
| 0.x | 5.x | `cordova-plugin-purchase ^13.x` | **Current** |
| 1.x | 7.x | TBD (Capacitor-native plugin) | Roadmap |

## Optional peer dependency

If you want auto-refresh on app resume (default behavior):

```bash
npm install @capacitor/app
npx cap sync
```

Or disable the listener with `options.refreshOnResume: false`. See [installation guide](https://iap.nossdev.com/guide/installation#optional-app-resume-listener).

## Development

```bash
mise install        # Node 22 + npm 10
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm test            # vitest run
npm run build       # tsup → dist/index.{js,cjs,d.ts}
npm run docs:dev    # vitepress dev (http://localhost:5173)
```

## License

MIT — see [LICENSE](./LICENSE).
