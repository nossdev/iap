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

Android-only in practice. The user chose a payment method that requires external clearance (cash, an e-wallet, certain bank transfers). Nothing is granted yet. Tell the user "we'll grant access when payment clears", and wait for `purchase-pending-resolved`.

### `purchase-pending-resolved`

```typescript
iap.on('purchase-pending-resolved', ({ productId, status }) => {
  // status: 'purchased' | 'cancelled'
});
```

The counterpart to `purchase-pending`, and what lets a paywall take its "waiting for payment" copy back down. Fires at most once per pending purchase.

`purchased` means it cleared **and the entitlement is already in place** — iap verified and acknowledged the transaction before emitting. `cancelled` means the store has it neither owned nor waiting: the payment failed, expired, or was abandoned.

iap remembers pending purchases across launches, because they usually resolve with the app closed — a Play e-wallet payment can take hours. The mark is checked shortly after `initialize()` and on every resume, so the event can arrive in a much later session than the purchase.

::: warning `cancelled` is Android-only, and may never arrive
It fires only where the platform can distinguish "gone" from "still waiting" — Play's purchase state. On iOS a deferred purchase (Ask to Buy) that is never approved produces **no signal at all**, so iap says nothing rather than guessing.

So treat `purchased` as the event you build on, and `cancelled` as a bonus when the platform can supply it. Do not leave a UI permanently blocked waiting for either: iap drops a pending mark it has not been able to resolve after **30 days**, silently and with no event, because by then the mark is iap's unanswered question rather than a purchase in progress.
:::

### `transaction-updated`

```typescript
iap.on('transaction-updated', ({ productId, purchase }) => {
  // purchase: StorePurchase
});
```

A transaction arrived **outside** a `purchase()` call: a subscription renewal, a refund or revocation, an Ask-to-Buy approval, a pending purchase clearing.

It fires *before* iap has verified anything, so treat it as "the store says something happened", not as an entitlement change. The authoritative signal is still `entitlements-changed`, which follows if your backend confirms it. Useful for logging, or for showing a spinner while the verification round-trip happens.

::: warning iOS only
The native layer feeds this from Apple's `Transaction.updates`; there is no Android equivalent. On Android the same ground is covered by reconciliation at launch and on resume, so a renewal or refund surfaces as `entitlements-changed` without a preceding `transaction-updated`. See [The native layer](/guide/native-layer).
:::

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

## Ordering guarantees

Within a single flow, events fire in deterministic order:

**Successful purchase:**
```
purchase-started
  → purchase-success
  → entitlements-changed (only if the entitlements actually changed)
```

**Successful restore:**
```
restore-started
  → restore-completed
  → entitlements-changed (only if the entitlements actually changed)
```

**A transaction arriving on its own** (a renewal, a refund, an Ask-to-Buy approval, a pending purchase clearing — iOS; see [`transaction-updated`](#transaction-updated)):
```
transaction-updated
  → entitlements-changed (only if the entitlements actually changed)
  → purchase-pending-resolved (only if this product was awaiting clearance)
```

In every case the **state is already updated before the first of these fires**, so a listener on any of them can read it with `iap.getEntitlements()`. The emission order above is the order the events arrive in, not a dependency: do not write a handler that assumes `entitlements-changed` has already run, because it is skipped entirely when the content did not change.

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
