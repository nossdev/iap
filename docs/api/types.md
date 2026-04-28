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
  /** Required for Android subscriptions; ignored on iOS / non-subs. */
  androidPlanId?: string;
}
```

What you pass into `createIAP({ products: [...] })`.

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

## `PurchaseResult`

```typescript
type PurchaseResult<T extends EntitlementBase = EntitlementBase> =
  | { status: 'success';             productId: string; transaction: VerifiedTransaction; entitlements: T[] }
  | { status: 'cancelled';           productId: string }
  | { status: 'pending';             productId: string }
  | { status: 'verification_failed'; productId: string; error: IAPError }
  | { status: 'failed';              productId: string; error: IAPError };
```

The discriminated union returned by `iap.purchase(productId)`. Switch on `status` to render the right UI without try/catch.

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
