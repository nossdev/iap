# `IAP` instance

The object returned by [`createIAP<TEntitlement>(config)`](/v7/api/create-iap).

```typescript
interface IAP<TEntitlement extends EntitlementBase = EntitlementBase> {
  initialize(): Promise<void>;
  refresh(): Promise<void>;
  destroy(): Promise<void>;
  purchase(opts: PurchaseOptions): Promise<PurchaseResult<TEntitlement>>;
  restorePurchases(): Promise<RestoreResult<TEntitlement>>;
  getProducts(): Promise<Product[]>;
  getStorefront(): Promise<Storefront | null>;
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
2. Resolves the native adapter (web → no-op stub, iOS/Android → `@capgo/native-purchases`).
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
  appUserId?: AppUserId;
}
```

| Field       | Type                          | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `productId` | `string`                      | yes      | Must be in `config.products`.                                                                                                                                                                                                                                                                                                                                                        |
| `appUserId` | [`AppUserId`](/v7/api/types#appuserid) | no       | UUID v4 (literal or async-fetched) forwarded to StoreKit's `appAccountToken` (iOS) / Play Billing's `obfuscatedAccountId` (Android). Three forms accepted: plain string, zero-arg fetcher `() => Promise<string>`, or ctx-form fetcher `(ctx) => Promise<string>` where `ctx.authHeaders` is populated from `backend.getAuthHeaders()`. See [`AppUserId`](/v7/api/types#appuserid) for full semantics. |

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

## `getStorefront()`

```typescript
getStorefront(): Promise<Storefront | null>
```

Returns the user's **storefront** — the country their App Store / Google Play account is registered to. This is the platform-blessed signal for region-dependent UI: regional offers/pricing, and gating external-payment links whose eligibility the OS itself keys to storefront country (**not** device locale or region).

```typescript
interface Storefront {
  countryCode: string;      // ISO 3166-1 alpha-2 (normalized), e.g. "US"
  countryCodeRaw: string;   // raw native: "USA" on iOS (alpha-3), "US" on Android (alpha-2)
  storefrontId?: string;    // Apple storefront id (iOS only); undefined on Android
  platform: 'apple' | 'google';
}
```

`countryCode` is normalized to ISO 3166-1 **alpha-2** across platforms (iOS's native code is alpha-3, Android's is alpha-2), so you compare one consistent value. The raw native code is kept on `countryCodeRaw`.

Resolves `null` when no storefront is available:

- on **web**;
- when the installed `@capgo/native-purchases` build doesn't register the native `getStorefront` method (see [Requirements](#requirements) below);
- when the native call fails;
- when the store reports an **empty** country (e.g. EU alternative distribution).

::: warning Read live; treat as a UX hint
Call `getStorefront()` each time you need it — **do not cache** it (the user can change their store region). The client value is a UX/targeting hint and can be unreliable: TestFlight has historically reported `"USA"` regardless of account region. For compliance- or entitlement-sensitive decisions, trust the **server-side signed storefront** your backend verifies (App Store Server API `storefront` / Play Developer API `regionCode`) — which pairs naturally with Attesto receipt validation.
:::

```typescript
// Show an external-payment link only where the storefront allows it.
const sf = await iap.getStorefront();
if (sf?.countryCode === 'US') {
  showExternalCheckoutLink();
}
```

### Requirements

`getStorefront()` is backed by `@capgo/native-purchases`' native storefront bridge, which was added in these plugin versions:

| Capacitor | `@capgo/native-purchases` | Install |
| --- | --- | --- |
| 8 | `>= 8.5.0` | the default `latest` tag |
| 7 | `>= 7.19.1` | `npm i @capgo/native-purchases@lts-v7` |

On **Capacitor 7**, install from the **`lts-v7`** dist-tag — npm's `latest` points at the 8.x (Capacitor 8) line, so a plain `npm i @capgo/native-purchases` would pull an incompatible major.

Availability is detected from the Capacitor plugin header, so on older plugin builds that don't register the native method the call resolves `null` cleanly (no bridge call, no native error) — upgrade the plugin and it lights up automatically with no API change. The orchestrator-side API, normalization, and web behavior are available regardless.

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

Available events: `ready`, `purchase-started`, `purchase-success`, `purchase-cancelled`, `purchase-pending`, `purchase-failed`, `verification-failed`, `restore-started`, `restore-completed`, `entitlements-changed`, `recovery-dropped-permanent`.

See [Events guide](/v7/guide/events) and [`EventMap`](/v7/api/events-reference) for full payload definitions.

## See also

- [Events](/v7/guide/events) — full payload reference
- [Error handling](/v7/guide/error-handling) — every code each method can throw
- [Configuration](/v7/guide/configuration) — what gets passed to `createIAP`
