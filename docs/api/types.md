# Types

Domain types exported from `@nossdev/iap`.

## `EntitlementBase`

```typescript
interface EntitlementBase {
  /** Logical identifier — e.g. 'premium', 'remove_ads', 'pro_features' */
  key: string;
  /** Native store productId that granted this entitlement */
  productId: string;
  /** ISO 8601 expiry; null for non-expiring (one-time non-consumable) */
  expiresAt: string | null;
}
```

The minimal shape every entitlement must have. Validated at runtime via zod when the backend response arrives.

Extend with your own fields:

```typescript
interface AppEntitlement extends EntitlementBase {
  tier: 'basic' | 'pro';
  features?: string[];
  trialEndsAt?: string;
}
```

Custom fields are NOT validated — your backend is trusted to return them correctly.

## `DefaultEntitlement`

```typescript
type DefaultEntitlement = EntitlementBase;
```

Alias used when consumers don't specify a `TEntitlement` generic. Identical to `EntitlementBase`.

## `Product`

```typescript
type ProductType = 'subscription' | 'product' | 'consumable';

interface Product {
  id: string;
  type: ProductType;
  title: string;
  description: string;
  /** Localized price string, e.g. "$4.99". MUST be rendered as-is. */
  priceString: string;
  /** Price in micros, BigInt as string to avoid precision loss. */
  priceMicros: string;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
}
```

Returned by `iap.getProducts()`. The combination of `priceMicros` + `currency` gives you precise math without floating-point issues; `priceString` is what you display.

## `ConfiguredProduct`

```typescript
interface ConfiguredProduct {
  id: string;
  type: ProductType;
  /**
   * Optional. Set for Android multi-plan subscriptions to disambiguate which
   * base plan to purchase. iOS ignores it. Single-plan Android subscriptions
   * and iOS-only configs may omit it.
   */
  androidPlanId?: string;
}
```

The shape of a single SKU manifest entry. Consumers either pass an array of these to `createIAP({ products: [...] })`, or have their backend return them via [`BackendAdapter.listProducts()`](/api/backend-adapter#listproducts-optional) — see [Backend contract → `products`](/guide/backend-contract#products-optional).

## `NativeTransaction`

```typescript
type Platform = 'apple' | 'google';

interface NativeTransaction {
  platform: Platform;
  productId: string;
  /**
   * Apple: StoreKit 2 transactionId (numeric string)
   * Google: Play Billing purchaseToken
   */
  token: string;
  /** Google only — required by Attesto's /v1/google/verify */
  packageName?: string;
  productType: ProductType;
  /** Plugin-native fields — opaque pass-through */
  raw?: unknown;
}
```

The shape the native adapter passes to backend verification. Most consumers never see this directly — it's an internal contract surfaced via `BackendAdapter` for custom transports.

## `VerifiedTransaction`

```typescript
interface VerifiedTransaction<TExtra = Record<string, unknown>> {
  id: string;
  productId: string;
  expiresAt: string | null;
  verifiedAt: string;
  raw?: TExtra;
}
```

What your backend returns inside a `verify*` success response. Generic over `TExtra` so backend-specific extra fields can be typed without `any`.

Surfaced to consumers via:
- `purchase-success` event payload
- `PurchaseResult` `success` variant

## `PurchaseOptions`

```typescript
interface PurchaseOptions {
  productId: string;
  appUserId?: AppUserId;
}
```

Argument shape for `iap.purchase(opts)`. Required: `productId`. Optional: `appUserId` — see below.

## `AppUserId`

```typescript
type AppUserId = string | (() => Promise<string>);
```

Pre-attach value supplied to `iap.purchase({ appUserId })`. Travels through StoreKit / Play Billing and surfaces on Attesto's verify response and outbound webhook payload as a top-level `appUserId` field — lets the integrator's backend join on user identity directly.

| Form               | Behavior                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `string`           | Validated as a UUID v4 then passed to native. Use when the caller already has the UUID (cached locally / app state).                                                                                                            |
| Async function     | Invoked **once per purchase** (no caching by iap — backend owns mint-or-lookup idempotency). Resolved value validated as a UUID v4. Wraps any thrown/rejected error as `IAPError(APP_USER_ID_FETCH_FAILED, cause: <original>)`. |

Non-UUID values throw `IAPError(INVALID_APP_USER_ID)`. Apple requires a UUID for `appAccountToken`; iap enforces the same constraint on Android for cross-platform consistency.

The fetcher signature is `() => Promise<string>` — no arguments. iap passes no implicit context; the caller's fetcher closes over whatever auth state it needs (session token, JWT, cookie). This is deliberate: different apps have different points in their UX where a user account exists, so coupling the fetcher to a specific auth callback would force a UX shape.

## `PurchaseResult`

```typescript
type PurchaseResult<T extends EntitlementBase = EntitlementBase> =
  | { status: 'success';             productId: string; transaction: VerifiedTransaction; entitlements: T[] }
  | { status: 'cancelled';           productId: string }
  | { status: 'pending';             productId: string }
  | { status: 'verification_failed'; productId: string; error: IAPError }
  | { status: 'failed';              productId: string; error: IAPError };
```

The discriminated union returned by `iap.purchase(opts)`. Switch on `status` to render the right UI without try/catch.

## `RestoreResult`

```typescript
interface RestoreResult<T extends EntitlementBase = EntitlementBase> {
  restored: number;
  entitlements: T[];
}
```

Returned by `iap.restorePurchases()`.

## `Platform`

```typescript
type Platform = 'apple' | 'google';
```

Native platform identifier. `'apple'` covers iOS / iPadOS / macOS Catalyst; `'google'` covers Android (Play Billing).

## `ProductType`

```typescript
type ProductType = 'subscription' | 'product' | 'consumable';
```

- `'subscription'` — auto-renewable subscription. Requires `androidPlanId` on Android.
- `'product'` — non-consumable one-time purchase (Remove Ads, lifetime unlock).
- `'consumable'` — consumable one-time purchase (coin packs, hint refills).

## Config types

| Type | Purpose |
|---|---|
| `IAPConfigInput` | What you pass to `createIAP` (some fields optional, defaults applied) |
| `IAPConfig` | Resolved internal type after parsing (all defaults filled) |
| `BackendConfigInput` / `BackendConfig` | The `backend` sub-tree |
| `StorageConfig` | The `storage` sub-tree |
| `OptionsConfig` | The `options` sub-tree |

Use `IAPConfigInput` when typing the object you construct; `IAPConfig` is rarely needed by consumers.

## See also

- [`createIAP`](/api/create-iap) — the factory
- [Errors](/api/errors) — `IAPError`, `IAPErrorCode`
- [Events reference](/api/events-reference) — `EventMap` and friends
