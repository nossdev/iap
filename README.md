# @nosslabs/iap

> Thin Capacitor IAP orchestrator. Server-side validation via [Attesto](https://attesto.nossdev.com).

**Status: `8.0.0-next.0` — the Capacitor 8 line, on `@next`** (built on `@capgo/native-purchases@^8`). `@latest` remains `7.1.0` (Capacitor 7) while the 8.x line soaks. The Capacitor 7 line continues as `7.x` (also on `@latest-7`) and the Capacitor 5 line (`cordova-plugin-purchase`) as `5.x` — `^7` and `^5` ranges still resolve to their own lines. See the [CHANGELOG](./CHANGELOG.md) for the `8.0.0-next.0` delta and [Migration](https://iap.nossdev.com/migration/).

```bash
# Capacitor 8 — release candidate, on @next
npm install @nosslabs/iap@next @capgo/native-purchases

# Capacitor 7 — the current @latest line
npm install @nosslabs/iap @capgo/native-purchases@lts-v7

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

- wraps [`@capgo/native-purchases`](https://github.com/Cap-go/native-purchases) for native purchase + restore,
- POSTs to **your** backend (which calls Attesto) for receipt validation,
- acknowledges native transactions only **after** the backend confirms — `autoAcknowledgePurchases: false` defers finishing on **both** iOS and Android, so there's no phantom grant and no iOS finish-before-verify race,
- caches entitlements locally for instant, reactive UI reads,
- recovers unfinished transactions across app launches.

It does **not**: talk to Attesto directly, define entitlement business logic, manage user auth, or ship paywall UI. Those belong to your app and your backend.

## Capacitor support matrix

| `@nosslabs/iap` | Capacitor | Native plugin | dist-tag | Status |
|---|---|---|---|---|
| 8.x | 8.x and later | `@capgo/native-purchases ^8` | `@next` | **Release candidate** — `8.0.0-next.0` |
| 7.x | 7.x | `@capgo/native-purchases@lts-v7` | `@latest`, `@latest-7` | **Current** |
| 5.x | 5.x | `cordova-plugin-purchase ^13.x` | `@latest-5` (pin via `^5`) | Maintenance |

## Optional peer dependency

If you want auto-refresh on app resume (default behavior):

```bash
npm install @capacitor/app
npx cap sync
```

Or disable the listener with `options.refreshOnResume: false`. See [installation guide](https://iap.nossdev.com/guide/installation#optional-app-resume-listener).

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
