# Configuration

`createIAP(config)` accepts a single config object. Every field is documented here. The schema is enforced at runtime via [zod](https://zod.dev) — invalid configs throw `IAPError(INVALID_CONFIG)` with field-specific error messages.

## Full shape

```typescript
import { createIAP } from '@nossdev/iap';
import type { IAPConfigInput } from '@nossdev/iap';

const config: IAPConfigInput = {
  // Product catalog
  products: [
    { id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly-plan' },
    { id: 'premium_yearly', type: 'subscription', androidPlanId: 'yearly-plan' },
    { id: 'remove_ads', type: 'product' },        // non-consumable
    { id: 'coin_pack_100', type: 'consumable' },
  ],

  // Backend transport
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
    timeoutMs: 10_000,
    retries: 2,
    // Optional escape hatches:
    // requestTransform: (req) => ({ ...req, path: '/v2' + req.path }),
    // responseTransform: (raw) => unwrapEnvelope(raw),
    // adapter: customBackendAdapter, // for non-HTTP transports
  },

  // Local persistence
  storage: {
    type: 'preferences',         // | 'memory' | 'custom'
    namespace: 'nossdev_iap',
    // adapter: customStorageAdapter, // when type === 'custom'
  },

  // Behavior
  options: {
    refreshOnResume: true,
    entitlementCacheTtlMs: 60 * 60 * 1000,         // 1 hour
    recoverUnfinishedTransactions: true,
    recoveryMaxBatch: 50,
    productPriceCacheTtlMs: 24 * 60 * 60 * 1000,   // 24 hours
    logLevel: 'info',                              // 'silent' | 'error' | 'warn' | 'info' | 'debug'
    // logger: customLogger,                       // implements Logger interface
  },
};

const iap = createIAP<MyEntitlement>(config);
```

## `products`

Required. At least one product must be configured.

```typescript
type ConfiguredProduct = {
  id: string;                                       // store identifier
  type: 'subscription' | 'product' | 'consumable';
  androidPlanId?: string;                           // required for subscriptions
};
```

- `id` matches the productId in App Store Connect / Play Console.
- `type: 'subscription'` — auto-renewable subscription. Requires `androidPlanId`.
- `type: 'product'` — non-consumable one-time purchase (e.g. "Remove Ads").
- `type: 'consumable'` — consumable one-time purchase (e.g. coin packs).
- `androidPlanId` matches the **base plan** identifier in Google Play Console. Required when `type: 'subscription'`. iOS ignores it.

::: warning Multiple plans per subscription product
If you have one subscription product with multiple base plans (e.g. monthly and yearly), register each plan as a separate `ConfiguredProduct` entry with the same `id` but different `androidPlanId`. The orchestrator routes the purchase to the right plan via `androidPlanId`.
:::

## `backend`

Required. Configures how the library talks to your server.

### Default HTTP transport

```typescript
type BackendConfig = {
  baseUrl: string;                                  // your backend root
  endpoints: {
    verifyApple: string;                            // POST — Apple receipt validation
    verifyGoogle: string;                           // POST — Google purchase validation
    entitlements: string;                           // GET — current entitlements
    restore: string;                                // POST — batch re-verify
  };
  getAuthHeaders: () =>
    | Record<string, string>
    | Promise<Record<string, string>>;              // called per request
  timeoutMs?: number;                               // default 10_000
  retries?: number;                                 // default 2 (max 5)
  requestTransform?: (req: HttpRequest) => HttpRequest | Promise<HttpRequest>;
  responseTransform?: (raw: unknown) => unknown | Promise<unknown>;
};
```

- `getAuthHeaders` is called fresh **before every request** so token refresh works automatically. Return whatever shape your backend authenticates with — `{ Authorization: 'Bearer ...' }` is typical, but anything goes (cookies, custom headers, etc.).
- `timeoutMs` is per-attempt. Retries are subject to the same timeout each.
- `retries` controls how many additional attempts on transient errors (5xx, 408, 429, network). 4xx auth/bad-response errors never retry.
- `requestTransform` rewrites the path/body/headers before send. Useful when your backend already has a different convention.
- `responseTransform` runs on the parsed JSON before zod validation. Useful when your backend wraps responses in an envelope.

See [Backend contract](/guide/backend-contract) for the request/response shapes the library expects.

### Custom transport

If your backend isn't HTTP/JSON (GraphQL, gRPC-web, Firebase, Supabase, etc.), pass a `BackendAdapter` instead:

```typescript
const config = {
  // ... products, storage, options ...
  backend: {
    adapter: myCustomAdapter, // implements BackendAdapter<TEntitlement>
    timeoutMs: 10_000,
    retries: 2,
  },
};
```

When `adapter` is provided, the `baseUrl` / `endpoints` / `getAuthHeaders` fields become optional. See [`BackendAdapter`](/api/backend-adapter) for the interface.

## `storage`

Optional. Defaults to `{ type: 'preferences', namespace: 'nossdev_iap' }`.

```typescript
type StorageConfig = {
  type: 'preferences' | 'memory' | 'custom';
  namespace: string;          // key prefix
  adapter?: StorageAdapter;   // when type === 'custom'
};
```

- `'preferences'` — backed by `@capacitor/preferences` (NSUserDefaults / SharedPreferences / localStorage).
- `'memory'` — in-memory map. Good for tests, transient sessions.
- `'custom'` — your own adapter implementing `StorageAdapter` (`get` / `set` / `remove` / `clear`).

The `namespace` is prepended to every key (e.g. `nossdev_iap.entitlements`) so multiple `createIAP` instances or other Preferences consumers don't collide.

## `options`

All optional with documented defaults.

| Field | Default | Description |
|---|---|---|
| `refreshOnResume` | `true` | Auto-call `iap.refresh()` when app returns from background. Requires optional `@capacitor/app`. |
| `entitlementCacheTtlMs` | `3_600_000` (1h) | When the cache age exceeds this, `initialize()` schedules a background refresh after `ready`. Reads still return cached values immediately. |
| `recoverUnfinishedTransactions` | `true` | Run recovery for unfinished transactions during `initialize()`. Disable only for tests / web. |
| `recoveryMaxBatch` | `50` | Cap on entries inspected per launch. Excess stays in storage for subsequent launches. |
| `productPriceCacheTtlMs` | `86_400_000` (24h) | TTL for cached native product info (titles, prices). Currently informational; auto-refresh on stale prices ships in v0.2. |
| `logLevel` | `'info'` | One of `'silent' \| 'error' \| 'warn' \| 'info' \| 'debug'`. |
| `logger` | console-backed | Implements `Logger` (error/warn/info/debug methods). Plug Sentry, Datadog, etc. |

## Generic `TEntitlement` type parameter

The factory is generic over your entitlement shape:

```typescript
import type { EntitlementBase } from '@nossdev/iap';

interface MyEntitlement extends EntitlementBase {
  // base fields (required by the library)
  key: string;
  productId: string;
  expiresAt: string | null;
  // your fields (typed all the way through)
  tier?: 'basic' | 'pro';
  features?: string[];
}

const iap = createIAP<MyEntitlement>(config);

const ent: MyEntitlement | null = iap.getEntitlement('premium');
ent?.tier; // typed
```

The library validates only the `EntitlementBase` shape on backend responses; your custom fields ride along through caches, events, and method returns without per-field validation. If you need strict end-to-end validation, supply your own zod schema via `config.backend.entitlementSchema`.

## Validation errors

Invalid configs throw `IAPError(INVALID_CONFIG)` synchronously from `createIAP()` with the failing field path:

```
IAPError: Invalid IAP configuration:
  - backend.baseUrl: Invalid url
  - products.0.androidPlanId: androidPlanId is required for subscription products

Hint: Check the field paths reported above against the IAPConfig schema (see /api/types).
```

Catch and surface this to your developer console; it's almost always a config typo.

## Next

- [Backend contract](/guide/backend-contract) — what your backend must implement
- [API: types](/api/types) — full type definitions
