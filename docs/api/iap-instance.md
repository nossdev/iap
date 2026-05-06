# `IAP` instance

The object returned by [`createIAP<TEntitlement>(config)`](/api/create-iap).

```typescript
interface IAP<TEntitlement extends EntitlementBase = EntitlementBase> {
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  destroy(): Promise<void>;
  purchase(opts: PurchaseOptions): Promise<PurchaseResult<TEntitlement>>;
  restorePurchases(): Promise<RestoreResult<TEntitlement>>;
  getProducts(): Promise<Product[]>;
  hasEntitlement(key: string): boolean;
  getEntitlements(): TEntitlement[];
  getEntitlement(key: string): TEntitlement | null;
  on<K extends EventName<TEntitlement>>(
    event: K,
    handler: (payload: EventPayload<K, TEntitlement>) => void,
  ): Unsubscribe;
}
```

## `initialize()`

```typescript
initialize(): Promise<void>
```

One-time setup. Idempotent — calling twice resolves immediately the second time.

Steps:

1. Loads cached entitlements from storage (warm cache).
2. Resolves the native adapter (web → no-op stub, iOS/Android → cordova-plugin-purchase).
3. Recovers any unfinished transactions from prior sessions (capped at `recoveryMaxBatch`).
4. Wires the app-resume listener if `refreshOnResume: true` and `@capacitor/app` is installed.
5. If cache age exceeds `entitlementCacheTtlMs`, schedules a background `refresh()` after `ready`.
6. Emits `ready`.

After resolution, all read methods are safe.

## `refresh()`

```typescript
refresh(): Promise<void>
```

Fetches `/entitlements` from your backend and replaces the local cache. Emits `entitlements-changed` if the new list differs from the previous (shallow compared).

Throws on transport failure (`BACKEND_UNAVAILABLE`, `BACKEND_TIMEOUT`, etc.). Doesn't auto-retry beyond the configured `retries` count.

```typescript
try {
  await iap.refresh();
} catch (error) {
  if (isIAPError(error) && error.recoverable) {
    // transient — UI can offer retry
  }
}
```

## `destroy()`

```typescript
destroy(): Promise<void>
```

Tears down event listeners, removes the resume listener, disposes the native adapter. **Does NOT clear the persisted entitlement cache.** For multi-user logout flows, also clear your storage adapter.

::: warning Not safe mid-purchase
Don't call `destroy()` while `iap.purchase()` is in flight — the native `acknowledge()` step can become a no-op, leading to a 3-day Google auto-refund. Await the in-flight purchase first.
:::

## `purchase(opts)`

```typescript
purchase(opts: PurchaseOptions): Promise<PurchaseResult<TEntitlement>>
```

Starts a purchase. Returns a discriminated union — does NOT throw on user cancellation, pending payment, or backend rejection.

### Options

```typescript
interface PurchaseOptions {
  productId: string;
  appUserId?: string | (() => Promise<string>);
}
```

| Field       | Type                                  | Required | Notes                                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `productId` | `string`                              | yes      | Must be in `config.products`.                                                                                                                                                                                                                                                    |
| `appUserId` | `string \| (() => Promise<string>)` | no       | If supplied, validated as a UUID v4 then forwarded to StoreKit's `appAccountToken` (iOS) / Play Billing's `obfuscatedAccountId` (Android). Either a literal UUID v4 or an async fetcher invoked once per purchase. See [`AppUserId`](/api/types#appuserid) for fetcher semantics. |

```typescript
type PurchaseResult<T> =
  | { status: 'success';             productId: string; transaction: VerifiedTransaction; entitlements: T[] }
  | { status: 'cancelled';           productId: string }
  | { status: 'pending';             productId: string }
  | { status: 'verification_failed'; productId: string; error: IAPError }
  | { status: 'failed';              productId: string; error: IAPError };
```

**Throws** only on programming errors / pre-flight failures:
- `IAPError(NOT_INITIALIZED)`
- `IAPError(ALREADY_IN_PROGRESS)` — a purchase for the same productId is already running
- `IAPError(PRODUCT_NOT_FOUND)` — productId not in `config.products`
- `IAPError(PLATFORM_NOT_SUPPORTED)` — called on web
- `IAPError(INVALID_APP_USER_ID)` — `appUserId` (literal or fetcher-returned) isn't a UUID v4
- `IAPError(APP_USER_ID_FETCH_FAILED)` — async fetcher threw or rejected (original error attached as `cause`)

Emits `purchase-started`, then exactly one of: `purchase-success` (+ `entitlements-changed`), `purchase-cancelled`, `purchase-pending`, `verification-failed`, `purchase-failed`. The two appUserId errors are pre-flight (caller-side fault) and surface synchronously without emitting `purchase-started`.

## `restorePurchases()`

```typescript
restorePurchases(): Promise<RestoreResult<TEntitlement>>
```

Re-verifies all owned transactions with the backend. Wire to a "Restore Purchases" button.

```typescript
interface RestoreResult<T> {
  restored: number;       // count of native transactions submitted
  entitlements: T[];      // consolidated list after backend verification
}
```

Throws `IAPError` on transport / verification failure. Wrap in try/catch.

Emits `restore-started`, then `restore-completed` (+ `entitlements-changed` if the list changed).

::: tip Empty owned list
If the platform store reports no owned transactions (fresh install, signed-out Apple ID), the library short-circuits — it does NOT call the backend and preserves whatever entitlements were already cached. To force-reconcile, call `iap.refresh()` afterward.
:::

## `getProducts()`

```typescript
getProducts(): Promise<Product[]>
```

Returns native pricing merged with configured metadata. One entry per product the platform store recognizes.

```typescript
interface Product {
  id: string;
  type: 'subscription' | 'product' | 'consumable';
  title: string;
  description: string;
  priceString: string;     // localized, e.g. "$4.99"
  priceMicros: string;     // BigInt as string
  currency: string;        // ISO 4217, e.g. "USD"
}
```

Products configured in `createIAP({ products })` but not yet ingested by the platform store are silently skipped. On web, returns `[]`.

::: warning Always render `priceString`
Apple and Google's developer agreements require displaying the localized price from the native API, not a hardcoded one. Rendering "$4.99" when the user's region shows €4.99 is a reviewability risk.
:::

## `hasEntitlement(key)`

```typescript
hasEntitlement(key: string): boolean
```

Synchronous read against the in-memory cache. O(1) (linear scan over a typically-small array).

## `getEntitlements()`

```typescript
getEntitlements(): TEntitlement[]
```

Returns a defensive shallow copy of the entitlement array. Each entitlement object is frozen — you can read its fields but not mutate them.

## `getEntitlement(key)`

```typescript
getEntitlement(key: string): TEntitlement | null
```

Returns the frozen entitlement matching `key`, or `null` if not found.

## `on(event, handler)`

```typescript
on<K extends EventName<TEntitlement>>(
  event: K,
  handler: (payload: EventPayload<K, TEntitlement>) => void,
): Unsubscribe
```

Subscribe to an event. Returns an unsubscribe function — **you must call it** when tearing down the subscription.

```typescript
const unsubscribe = iap.on('entitlements-changed', ({ entitlements }) => {
  store.setEntitlements(entitlements);
});

// later
unsubscribe();
```

Available events: `ready`, `purchase-started`, `purchase-success`, `purchase-cancelled`, `purchase-pending`, `purchase-failed`, `verification-failed`, `restore-started`, `restore-completed`, `entitlements-changed`, `price-stale`, `error`.

See [Events guide](/guide/events) and [`EventMap`](/api/events-reference) for full payload definitions.

## See also

- [Events](/guide/events) — full payload reference
- [Error handling](/guide/error-handling) — every code each method can throw
- [Configuration](/guide/configuration) — what gets passed to `createIAP`
