# `createIAP`

```typescript
function createIAP<TEntitlement extends EntitlementBase = EntitlementBase>(
  config: IAPConfigInput,
): IAP<TEntitlement>;
```

Factory. Returns a fully-typed `IAP` instance bound to your entitlement shape.

## Generic parameter

`TEntitlement` defaults to `EntitlementBase` (`{ key, productId, expiresAt }`). Pass your own to type custom entitlement fields end-to-end:

```typescript
interface MyEntitlement extends EntitlementBase {
  tier: 'basic' | 'pro';
  features?: string[];
}

const iap = createIAP<MyEntitlement>(config);

iap.getEntitlement('premium')?.tier; // typed as 'basic' | 'pro'
```

The base shape (`key`, `productId`, `expiresAt`) is validated at runtime via zod. Your custom fields ride through unvalidated; the backend is trusted to return them correctly. If you need strict per-field validation, pass a custom backend adapter that runs your own zod schema.

## Validation

The config is validated synchronously via zod. Any structural error throws `IAPError(INVALID_CONFIG)` immediately:

```typescript
try {
  const iap = createIAP({ /* malformed config */ });
} catch (error) {
  if (isIAPError(error) && error.code === 'INVALID_CONFIG') {
    console.error(error.message); // contains field paths
  }
}
```

See [Configuration](/guide/configuration) for the full schema.

## Lifecycle

The factory does NOT call native code or hit the network. After `createIAP`:

1. Call `iap.initialize()` once your auth state is ready.
2. Use the instance throughout your app's lifetime (one per process).
3. Optionally call `iap.destroy()` on logout / app teardown.

::: warning One instance per process
Don't call `createIAP` per render or per route. The instance owns event listeners, native plugin handles, and the storage cache — multiple instances will fight over the same `@capgo/native-purchases` plugin on the native side.
:::

## Examples

### Minimal

```typescript
const iap = createIAP({
  products: [{ id: 'remove_ads', type: 'product' }],
  backend: {
    baseUrl: 'https://api.example.com',
    endpoints: {
      verifyApple: '/api/iap/verify/apple',
      verifyGoogle: '/api/iap/verify/google',
      entitlements: '/api/iap/entitlements',
      restore: '/api/iap/restore',
    },
    getAuthHeaders: () => ({}),
  },
});
```

### Custom transport

```typescript
const iap = createIAP({
  products: [{ id: 'premium', type: 'subscription', androidPlanId: 'monthly' }],
  backend: {
    adapter: myFirebaseFunctionsAdapter,
    timeoutMs: 15_000,
    retries: 1,
  },
});
```

See [`BackendAdapter`](/api/backend-adapter) for the interface.

### Backend-driven product manifest

Omit `products` to have the library fetch the SKU manifest from your backend during `initialize()`:

```typescript
const iap = createIAP({
  // No `products` field
  backend: {
    baseUrl: 'https://api.example.com',
    endpoints: {
      verifyApple: '/api/iap/verify/apple',
      verifyGoogle: '/api/iap/verify/google',
      entitlements: '/api/iap/entitlements',
      restore: '/api/iap/restore',
      products: '/api/iap/products', // ← new
    },
    getAuthHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` }),
  },
});
```

Configs that supply neither `products` nor a way for the backend to provide them throw `IAPError(INVALID_CONFIG)` at parse time. See [Backend contract → `products`](/guide/backend-contract#products-optional) for the response shape and the App-Store-Connect-pre-registration caveat.

### No backend at all

```typescript
const iap = createIAP({
  products: [{ id: 'household_yearly', type: 'subscription', androidPlanId: 'yearly' }],
  android: { packageName: 'com.example.app' },
  verification: {
    mode: 'local',
    entitlements: (purchase) => [
      { key: 'household', productId: purchase.productId, expiresAt: purchase.expiresAt },
    ],
  },
});
```

`verification` takes the place of `backend`. Read [Offline and no-backend use](/guide/offline-and-no-backend) first — on Android no cryptographic check is possible on the device.

### What `createIAP()` rejects at parse time

All of these throw `IAPError(INVALID_CONFIG)` synchronously:

| Config | Why |
|---|---|
| Neither `backend` nor `verification` | Something has to verify a purchase before an entitlement is granted. |
| Both `backend` and `verification` | Two answers to the same question, with no rule for which wins. |
| `verification` without `entitlements` | iap cannot know what a product entitles anyone to, and there is no backend to ask. |
| `verification` without `products` | There is no backend to curate a manifest either. |
| `verification.appUserId` that is not a UUID | It would never match a purchase, so it would silently refuse every one. |
| `products: []`, or duplicate product ids | |
| `backend` with no `baseUrl`/`endpoints`/`getAuthHeaders` and no custom `adapter` | |
| `products` omitted with no way for the backend to supply it | |

### Typed entitlements + custom logger

```typescript
interface AppEntitlement extends EntitlementBase {
  tier: 'free' | 'basic' | 'pro';
  features: string[];
}

const iap = createIAP<AppEntitlement>({
  products: [/* ... */],
  backend: { /* ... */ },
  options: {
    logLevel: 'warn',
    logger: {
      error: (msg, ctx) => Sentry.captureMessage(msg, { extra: ctx }),
      warn:  (msg, ctx) => Sentry.captureMessage(msg, { extra: ctx, level: 'warning' }),
      info:  () => {},
      debug: () => {},
    },
  },
});
```

## See also

- [Configuration](/guide/configuration) — every field
- [`IAP` instance](/api/iap-instance) — methods on the returned object
- [Errors](/api/errors) — `INVALID_CONFIG` shape
