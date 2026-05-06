# Events

`@nosslabs/iap` emits typed events you can subscribe to. Each event has a strongly-typed payload — unknown event names are a compile error.

## Subscribing

```typescript
const unsubscribe = iap.on('entitlements-changed', ({ entitlements, previous }) => {
  console.log('cache changed', entitlements.length);
});

// later, when tearing down:
unsubscribe();
```

`on()` returns an unsubscribe function. Call it from `onUnmounted` (Vue), `useEffect` cleanup (React), or your framework's equivalent — the library does NOT auto-unsubscribe on `iap.destroy()` for you, so always retain and call the returned function.

## Event reference

### `ready`

```typescript
iap.on('ready', () => { /* payload: undefined */ });
```

Emitted exactly once, after `initialize()` has loaded the cache, recovered unfinished transactions (if any), and wired up listeners. After `ready`, all read methods are safe.

If you need a Promise interface, just `await iap.initialize()` — `ready` is for consumers who initialize centrally and react in components.

### `purchase-started`

```typescript
iap.on('purchase-started', ({ productId }) => { /* ... */ });
```

Emitted when `iap.purchase({ productId })` calls into the native plugin. Useful for showing a spinner before the system purchase sheet animates in.

### `purchase-success`

```typescript
iap.on('purchase-success', ({ productId, transaction }) => {
  // transaction: VerifiedTransaction
  //   { id, productId, expiresAt, verifiedAt, raw? }
  analytics.track('purchase_completed', { productId });
});
```

Emitted after the backend confirms the purchase AND the native transaction has been finished. By the time this fires, the entitlement cache is already updated and `entitlements-changed` has been emitted (in that order).

### `purchase-cancelled`

```typescript
iap.on('purchase-cancelled', ({ productId }) => { /* ... */ });
```

User dismissed the system purchase sheet. No charge, no state change. Most apps don't need to handle this — `iap.purchase()` returns `{ status: 'cancelled' }` for the synchronous flow. Use the event for analytics ("paywall dismissed without purchase").

### `purchase-pending`

```typescript
iap.on('purchase-pending', ({ productId }) => { /* ... */ });
```

Android-only. The user chose a payment method that requires external clearance (cash, certain bank transfers). The transaction is in a holding state — Google will eventually call your backend's RTDN webhook when it clears, and your backend should update entitlements. Tell the user "we'll grant access when payment clears", then trust your backend.

### `purchase-failed`

```typescript
iap.on('purchase-failed', ({ productId, error }) => {
  // error: IAPError — STORE_ERROR, BILLING_NOT_AVAILABLE, etc.
});
```

Native-side failure (network drop in store dialog, store unavailable, payment method declined). Distinct from `verification-failed` — that's backend-side.

### `verification-failed`

```typescript
iap.on('verification-failed', ({ productId, error }) => {
  // error: IAPError — VERIFICATION_REJECTED, BACKEND_TIMEOUT, etc.
});
```

The native side completed, but the backend rejected or couldn't be reached. The transaction stays in the unfinished queue for retry on next launch / refresh. Show the user "we'll retry shortly" rather than "purchase failed" — they may already have been charged.

### `restore-started`

```typescript
iap.on('restore-started', () => { /* payload: undefined */ });
```

Emitted at the start of `iap.restorePurchases()`. Useful for spinner state.

### `restore-completed`

```typescript
iap.on('restore-completed', ({ restored, entitlements }) => {
  toast(`Restored ${restored} purchase(s)`);
});
```

Emitted at the end of `iap.restorePurchases()`. By this point, the entitlement cache is updated and `entitlements-changed` has fired (if the set actually changed).

### `entitlements-changed`

```typescript
iap.on('entitlements-changed', ({ entitlements, previous }) => {
  store.setEntitlements(entitlements);
});
```

Emitted whenever the entitlement cache is updated AND the new set differs from the previous set (shallow compared by `key + productId + expiresAt`). Sources:

- A successful purchase
- A successful restore
- A successful `iap.refresh()`
- Recovery of an unfinished transaction on launch / resume
- Cache TTL expiry triggering a background refresh

::: tip Reactive-store hookup
This is the event you wire to your Pinia / React / Svelte store. See [Vue + Quasar recipe](/recipes/vue-quasar) and [React recipe](/recipes/react) for full examples.
:::

The library de-duplicates: identical entitlement lists do NOT emit. If you must observe every refresh attempt regardless of change, listen for the underlying transitions (`purchase-success`, `restore-completed`) instead.

### `price-stale`

```typescript
iap.on('price-stale', ({ productId, lastFetchedAt }) => {
  // Currently informational; auto-refetch ships in v0.2.
});
```

Emitted when `iap.getProducts()` returns a product whose native price was cached longer than `productPriceCacheTtlMs` ago (default 24h). For v0.1, this is a passive signal — your UI can choose to call `iap.getProducts()` again or display a warning. v0.2 will auto-refetch.

### `error`

```typescript
iap.on('error', ({ error }) => {
  // error: IAPError
  Sentry.captureException(error);
});
```

A catch-all for errors that don't surface through a Promise rejection — primarily background-recovery failures during `initialize()` (where rejecting the init promise would be unhelpful). Wire to your error reporter; do NOT use for purchase-flow errors (those go through `iap.purchase()`'s discriminated union).

## Ordering guarantees

Within a single flow, events fire in deterministic order:

**Successful purchase:**
```
purchase-started
  → entitlements-changed (if entitlements actually changed)
  → purchase-success
```

**Successful restore:**
```
restore-started
  → entitlements-changed (if entitlements actually changed)
  → restore-completed
```

`entitlements-changed` always fires **before** `purchase-success`/`restore-completed`, so a listener on the latter can already read the new state via `iap.getEntitlements()`.

## Compared to `iap.purchase()` return value

For the synchronous purchase flow, prefer the return value over event subscriptions:

```typescript
const result = await iap.purchase({ productId: 'premium_monthly' });
if (result.status === 'success') { /* ... */ }
```

Events are for **cross-component reactivity** (a paywall component triggers a purchase; a header avatar component shows the new tier). The Promise return is for **the code that initiated the action**.

## TypeScript: typing your entitlement

The event payloads are generic over `TEntitlement`:

```typescript
interface MyEntitlement extends EntitlementBase {
  tier: 'basic' | 'pro';
}

const iap = createIAP<MyEntitlement>(config);

iap.on('entitlements-changed', ({ entitlements }) => {
  entitlements[0].tier; // ← typed as 'basic' | 'pro'
});
```

See [`EventMap`](/api/events-reference) for the full mapping.

## Next

- [Error handling](/guide/error-handling) — every `IAPErrorCode` and how to recover
- [Vue + Quasar recipe](/recipes/vue-quasar) — Pinia store wired to events
- [React recipe](/recipes/react) — `useIAP()` hook pattern
