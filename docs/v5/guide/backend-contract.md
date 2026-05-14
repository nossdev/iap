# Backend contract

Your backend implements two-to-four required endpoints (plus one optional). The library calls them; they call [Attesto](https://attesto.nossdev.com). This page documents the exact request/response shapes the library expects.

::: tip Implementing a custom transport?
If your backend isn't HTTP/JSON (GraphQL, Firebase, Supabase, gRPC-web), implement a [`BackendAdapter`](/v5/api/backend-adapter) instead. The shapes below still apply at the domain level — only the wire encoding changes.
:::

## Overview

| Endpoint                | Method | Purpose                                              | Required?                                  |
|-------------------------|--------|------------------------------------------------------|--------------------------------------------|
| `verifyApple`           | POST   | Validate one Apple StoreKit transaction              | iOS-supporting builds only †               |
| `verifyGoogle`          | POST   | Validate one Google Play Billing transaction         | Android-supporting builds only †           |
| `entitlements`          | GET    | Return the user's current entitlements               | yes                                        |
| `restore`               | POST   | Validate a batch of platform receipts (re-link user) | yes                                        |
| `products`              | GET    | Return the SKU manifest the app should register      | optional                                   |

† At least one of `verifyApple` / `verifyGoogle` must be set. iOS-only consumers can omit `verifyGoogle` and vice versa — the library throws `IAPError(INVALID_CONFIG)` with a clear message if the runtime ever dispatches to a missing endpoint.

Paths are configured via `config.backend.endpoints`. The defaults shown in [Configuration](/v5/guide/configuration) — `/api/iap/verify/apple` etc. — are convention, not required.

## Authentication

The library calls `config.backend.getAuthHeaders()` **before every request** and merges the returned headers into the outgoing call. Your backend authenticates the user from those headers (typically `Authorization: Bearer <jwt>`).

If your backend returns 401/403, the library throws `IAPError(BACKEND_AUTH_FAILED)` and does not retry — that's a fatal client-side problem, not a transient one.

## `verifyApple`

```http
POST <baseUrl><endpoints.verifyApple>
Content-Type: application/json
Authorization: Bearer <user token>

{
  "platform": "apple",
  "token": "2000000123456789",
  "productId": "premium_monthly",
  "productType": "subscription"
}
```

- `token` — StoreKit 2 `transactionId`. The numeric string the plugin gives us.
- `productType` — `'subscription' | 'product' | 'consumable'`. Helps your backend decide expiry semantics.

### Successful response

```json
{
  "valid": true,
  "transaction": {
    "id": "2000000123456789",
    "productId": "premium_monthly",
    "expiresAt": "2026-04-30T12:00:00Z"
  },
  "entitlements": [
    {
      "key": "premium",
      "productId": "premium_monthly",
      "expiresAt": "2026-04-30T12:00:00Z",
      "tier": "pro"
    }
  ]
}
```

- `transaction` — required on verify (the library surfaces `transaction.id`, `productId`, `expiresAt` in `PurchaseResult`).
- `expiresAt` — ISO-8601 string or `null` for one-time non-consumables.
- `entitlements` — the user's **full** entitlement set after this verification (not a delta). The library replaces the cache with this list.
- Any extra fields you attach (e.g. `verifiedAt`, `traceId`, your own debug metadata) ride through unvalidated and unstripped — the library validates only the named fields above. Custom fields on entitlement objects (e.g. `tier`) likewise ride through; type them via `createIAP<MyEntitlement>` so consumer code stays typed.

### Rejected response

```json
{
  "valid": false,
  "error": "TRANSACTION_NOT_FOUND",
  "message": "Apple returned TRANSACTION_NOT_FOUND"
}
```

- `error` — required, stable machine-readable code your client may key on.
- `message` — optional human-readable detail. Both surface in the thrown `IAPError.message`.

When `valid: false`, the library throws `IAPError(VERIFICATION_REJECTED)`. The transaction stays in the unfinished queue; you can use `iap.refresh()` to re-attempt later, but the library does NOT auto-retry rejections (transient backend errors are retried; explicit rejections are not).

### Internal flow

```
client → your /verify/apple → Attesto POST /v1/apple/verify
       ←                    ←   { valid, expiresAt, ... }
```

Your backend translates Attesto's verdict into your entitlement model (look up the user, decide tier from product, set/update DB row, return your entitlement shape).

## `verifyGoogle`

Identical to `verifyApple` except for two extra Android-specific fields:

```json
{
  "platform": "google",
  "token": "ojnbalfgmieckdfgjnpekoam.AO-J1OyeQ8R...",
  "productId": "premium_monthly",
  "productType": "subscription",
  "packageName": "com.example.myapp",
  "androidPlanId": "monthly-plan"
}
```

- `token` — Play Billing `purchaseToken`. Long opaque string.
- `packageName` — required by Attesto's `/v1/google/verify` (Google Play's `purchases.subscriptions.get` is keyed on the package).
- `androidPlanId` — base plan id, when the product is a subscription with multiple plans.

Response shape is identical to `verifyApple`.

## `entitlements`

```http
GET <baseUrl><endpoints.entitlements>
Authorization: Bearer <user token>
```

### Response

```json
{
  "entitlements": [
    {
      "key": "premium",
      "productId": "premium_monthly",
      "expiresAt": "2026-04-30T12:00:00Z",
      "tier": "pro"
    }
  ]
}
```

This is the canonical refresh path. Called by:

- `iap.refresh()` (manual)
- App resume (when `refreshOnResume: true`)
- Cache TTL expiry (background refresh after `initialize()` emits `ready`)

The response replaces the entire local cache. Always return the full set, not a delta.

::: warning Empty list is meaningful
`{ "entitlements": [] }` means the user currently has **no** entitlements. The library will clear its cache and emit `entitlements-changed` with `entitlements: []`. Consumers should handle the empty case explicitly (lock premium UI, show paywall).
:::

## `restore`

```http
POST <baseUrl><endpoints.restore>
Content-Type: application/json
Authorization: Bearer <user token>

{
  "transactions": [
    {
      "platform": "apple",
      "token": "2000000123456789",
      "productId": "premium_monthly",
      "productType": "subscription"
    },
    {
      "platform": "apple",
      "token": "2000000987654321",
      "productId": "remove_ads",
      "productType": "product"
    }
  ]
}
```

The library calls this when the consumer invokes `iap.restorePurchases()` — typically wired to a "Restore Purchases" button. The library:

1. Asks the native plugin for all owned transactions (`getOwnedTransactions()`).
2. Sends them in one request to `/restore`.
3. Updates the entitlement cache from the consolidated response.

### Response

```json
{
  "valid": true,
  "entitlements": [
    {
      "key": "premium",
      "productId": "premium_monthly",
      "expiresAt": "2026-04-30T12:00:00Z"
    },
    {
      "key": "remove_ads",
      "productId": "remove_ads",
      "expiresAt": null
    }
  ]
}
```

- `valid: true` — required.
- `entitlements` — full entitlement set after restore (replaces cache).
- **No `transaction` field is required.** Restore is a batch operation; the library never reads a per-batch transaction echo. If you do attach one, it rides through via passthrough — the library just doesn't gate on it.
- Any other fields (analytics ids, server timestamps, debug metadata) ride through unvalidated.

The rejected shape mirrors verify (`{ valid: false, error, message? }`) and throws `IAPError(VERIFICATION_REJECTED)`.

If a single receipt in the batch is invalid, your backend should still validate the rest and return the consolidated state — the library doesn't have per-receipt failure handling for restore (it's an idempotent re-link, not a paid purchase).

The `iap.restorePurchases()` Promise resolves to `{ restored, entitlements }` where `restored` is the count of native transactions submitted to your backend (set by the library, not by your response).

## `products` (optional)

Return the SKU manifest the app should register. The library calls this during `initialize()` **only when** `config.products` is omitted — letting the backend curate which SKUs to surface (feature flags, A/B mixes, regional catalogs, evolving catalogs between app releases).

```http
GET <baseUrl><endpoints.products>
Authorization: Bearer <user token>
```

### Response

```json
{
  "products": [
    { "id": "premium_monthly", "type": "subscription", "androidPlanId": "monthly-plan" },
    { "id": "premium_yearly",  "type": "subscription", "androidPlanId": "yearly-plan" },
    { "id": "remove_ads",      "type": "product" }
  ]
}
```

- `id` — must match the product id in App Store Connect / Google Play Console.
- `type` — `'subscription' | 'product' | 'consumable'`.
- `androidPlanId` — required when `type: 'subscription'`. Maps to the Play Console base plan id.

::: warning Pre-registration is non-negotiable
Every id you return MUST already be registered in App Store Connect AND Google Play Console for the platforms you ship on. The backend manifest is a **curated subset** of pre-registered SKUs, not a registration. A new id surfaced only by the backend will fail at the platform store with no usable error.
:::

When to use this vs static `products: [...]`:

| Static `products: [...]`                          | Backend `endpoints.products`                                |
|---------------------------------------------------|-------------------------------------------------------------|
| Small, stable catalog                             | Catalog evolves between releases                            |
| Ships with the app — always available offline     | Requires backend to be reachable on first launch            |
| Simpler config; one less failure surface          | Lets you toggle SKUs by region, cohort, feature flag        |
| Ideal for tutorials, tests, prototypes            | Production realism for apps that A/B price points or plans  |

## Response transforms

If your backend wraps responses in an envelope (`{ data: ..., meta: ... }`), use the optional `responseTransform`:

```typescript
backend: {
  // ...
  responseTransform: (raw) => raw.data,
};
```

Runs on the parsed JSON before the library's zod validation. See [Configuration → backend](/v5/guide/configuration#backend).

## Error responses

The library distinguishes four error categories — all observable as `IAPErrorCode` values:

| HTTP / condition                      | Code                       | Retried? |
|---------------------------------------|----------------------------|----------|
| Network failure, DNS, connection drop | `BACKEND_UNAVAILABLE`      | yes      |
| Timeout (`timeoutMs` exceeded)        | `BACKEND_TIMEOUT`          | yes      |
| 5xx                                   | `BACKEND_UNAVAILABLE`      | yes      |
| 408, 429                              | `BACKEND_UNAVAILABLE`      | yes      |
| 401, 403                              | `BACKEND_AUTH_FAILED`      | no       |
| Other 4xx, malformed JSON, schema fail | `BACKEND_BAD_RESPONSE`    | no       |
| `{ valid: false }` from verify        | `VERIFICATION_REJECTED`    | no       |

Retry count comes from `config.backend.retries` (default 2, max 5). Backoff is exponential with jitter.

## Reference implementation sketch

A minimal Express handler — not production code, just the shape:

```typescript
import express from 'express';
import { Attesto } from '@nossdev/attesto-server';

const app = express();
const attesto = new Attesto({ apiKey: process.env.ATTESTO_KEY });

app.post('/api/iap/verify/apple', requireAuth, async (req, res) => {
  const { token, productId, productType } = req.body;
  const userId = req.user.id;

  const verdict = await attesto.verifyApple({
    transactionId: token,
    productId,
  });

  if (!verdict.valid) {
    return res.json({ valid: false, reason: verdict.reason });
  }

  await db.entitlements.upsert({
    userId,
    key: keyForProduct(productId),
    productId,
    expiresAt: verdict.expiresAt,
    tier: tierForProduct(productId),
  });

  const entitlements = await db.entitlements.findActive(userId);

  res.json({
    valid: true,
    transaction: {
      id: token,
      productId,
      expiresAt: verdict.expiresAt,
      verifiedAt: new Date().toISOString(),
    },
    entitlements,
  });
});
```

The same pattern repeats for `/verify/google`, `/entitlements`, `/restore`. See the Attesto docs for the full server SDK reference.

## Next

- [Configuration](/v5/guide/configuration) — how to point the library at your endpoints
- [Error handling](/v5/guide/error-handling) — what your UI does with each error code
- [`BackendAdapter`](/v5/api/backend-adapter) — for non-HTTP transports
