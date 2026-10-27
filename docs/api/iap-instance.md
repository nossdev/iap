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
  getStorefront(): Promise<Storefront | null>;
  hasEntitlement(key: string): boolean;
  getEntitlements(): TEntitlement[];
  getEntitlement(key: string): TEntitlement | null;
  getEntitlementsVerifiedAt(): string | null;
  reset(): Promise<void>;
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

Fetches the current entitlements from the verification source — `/entitlements` on your backend, or the store itself in [local mode](/guide/offline-and-no-backend) and replaces the local cache. Emits `entitlements-changed` if the new list differs from the previous (shallow compared).

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
| `appUserId` | [`AppUserId`](/api/types#appuserid) | no       | An RFC 9562 UUID of any version (literal or async-fetched) forwarded to StoreKit's `appAccountToken` (iOS) / Play Billing's `obfuscatedAccountId` (Android). Three forms accepted: plain string, zero-arg fetcher `() => Promise<string>`, or ctx-form fetcher `(ctx) => Promise<string>` where `ctx.authHeaders` is populated from `backend.getAuthHeaders()`. See [`AppUserId`](/api/types#appuserid) for full semantics. |

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
- `IAPError(INVALID_APP_USER_ID)` — `appUserId` (literal or fetcher-returned) isn't an RFC 9562 UUID
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

Each entry carries the store's localized pricing, and for a subscription its
billing period, subscription group, introductory offer and promotional offers.
See [`Product`](/api/types#product) for the full shape — it is defined once
there rather than repeated here.

```typescript
const products = await iap.getProducts();
// → [{ id, type, title, description, priceString, priceMicros, currency,
//      subscriptionPeriod, subscriptionGroupId, introductoryOffer,
//      promotionalOffers, androidOfferToken, androidOfferId,
//      androidBasePlanId }]
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

::: tip In local mode these three skip expired entitlements
With [local verification](/guide/offline-and-no-backend), there is no backend to re-ask, so the three reads filter out entitlements whose `expiresAt` has passed by the device clock (plus any `options.entitlementGraceMs`). A subscription that lapses while the app is backgrounded stops granting immediately rather than at the next refresh.

**With a backend they do not filter**, deliberately: your backend is the authority on what is granted, and it may return an entitlement whose `expiresAt` has passed on purpose — that is what a store-side grace period or billing retry looks like. iap second-guessing it against the device clock would perform a downgrade your backend did not ask for, and a device with a fast clock would lock out a paying user. Filter on `expiresAt` yourself if you want that behaviour.

In **neither** mode is an entitlement dropped because a refresh failed or the cache is stale. See [Offline and no-backend use](/guide/offline-and-no-backend).
:::

## `getEntitlementsVerifiedAt()`

```typescript
getEntitlementsVerifiedAt(): string | null
```

When the entitlements were last confirmed by the verification source — your backend, or the device in local mode. ISO 8601, or `null` if they have never been confirmed on this install.

Exposed so an app can apply its own staleness tolerance. iap deliberately does not revoke on staleness: a cached entitlement stands until it expires, because a network error must never cost a paying user their access.

## `reset()`

```typescript
reset(): Promise<void>
```

Erases everything iap has stored on this device: the entitlement cache, the unfinished-transaction queue and any pending-purchase marks. For a "delete everything" control.

Two things it is not:

- **Not `destroy()`.** That tears the instance down and deliberately *keeps* the cache, so a new instance sees the user's entitlements immediately. `reset()` is the opposite — the instance stays usable, and a `refresh()` repopulates from the verification source.
- **Not a revocation.** The store still owns the purchase, because the user paid for it, and a restore will bring the entitlement back.

Best-effort on storage: a failure to clear one key is logged and the rest is still cleared. Emits
`entitlements-changed` carrying the real previous list, unless there was nothing to remove.

It throws in one case: `ALREADY_IN_PROGRESS`, while a `purchase()` is in flight. The
unfinished-transaction record is written *before* verification precisely so a purchase survives a
crash, and deleting it mid-flight would leave a purchase neither acknowledged nor tracked — which
Google auto-refunds after three days. The error is `recoverable`: await the purchase, then reset.

After `destroy()` it still wipes, and does not throw. That is the safest moment to do it — the
orchestrators are gone, so nothing can re-persist — and a teardown racing a "delete my data" tap
is a real sequence. `destroy()` deliberately leaves the cache on disk, so returning early would
leave it there while telling the caller their data was gone.

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

See [Events guide](/guide/events) for what each event means, and [`EventMap`](/api/events-reference) for the full payload definitions — the event list lives there rather than being repeated here.

## See also

- [Events](/guide/events) — full payload reference
- [Error handling](/guide/error-handling) — every code each method can throw
- [Configuration](/guide/configuration) — what gets passed to `createIAP`
