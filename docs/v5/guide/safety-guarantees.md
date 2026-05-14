# Safety guarantees

This page documents the correctness guarantees `@nosslabs/iap` makes — and the bugs you can rule out by relying on them.

## 1. Backend-confirmed `finish()`

**The library NEVER calls `transaction.finish()` until your backend returns `{ valid: true }`.**

### Why this matters

Both StoreKit 2 and Google Play Billing 7 use **deferred finish** semantics: a transaction stays in the user's purchase queue until your code explicitly acknowledges it. If your app crashes, the network drops, or the user kills the process between "store says paid" and "your backend says verified", the transaction remains in the queue.

Naive clients call `finish()` immediately on receiving the transaction. That's wrong: you've told the store "we got it" before your backend even saw the receipt. If your backend later rejects the receipt (replay, sandbox/prod mismatch, fraud signal), the user already paid — but you have no record and no recovery hook.

### What this rules out

- **Phantom grants** — UI showing premium when the receipt was never validated.
- **Lost purchases on crash** — killed-mid-flow transactions retry on next launch (see [at-least-once recovery](#at-least-once-recovery)).
- **Replay attacks** — every receipt is validated server-side via Attesto before the client side proceeds.

### Code reference

The order is enforced in [`src/core/purchase-flow.ts`](https://github.com/nossdev/iap/blob/main/src/core/purchase-flow.ts):

```typescript
// 1. native gives us the transaction
const tx = await native.waitForTransaction(productId);

// 2. persist BEFORE calling backend (recovery anchor)
await unfinished.add(tx);

// 3. call backend
const response = await backend.verifyApple(tx);

// 4. only on success → finish + cache + emit
if (response.valid) {
  await native.finishTransaction(tx);   // ← finish() AFTER verify
  await unfinished.remove(tx);
  cache.update(response.entitlements);
  emit('purchase-success', { ... });
}
```

If step 3 throws or step 4's `valid` is false, the transaction stays in `unfinished_transactions` for retry.

## 2. At-least-once recovery

**Every transaction the native side hands us is verified at least once, even across crashes.**

### How it works

On purchase (`PurchaseFlow`), the library:

1. Persists the native transaction to the `unfinished_transactions` storage key.
2. Calls the backend.
3. On success: removes from storage and calls `finish()`.
4. On failure: leaves the entry in storage.

On every `initialize()` (and optionally on app resume — see [`refreshOnResume`](/v5/guide/configuration#options)), the library:

1. Reads `unfinished_transactions`.
2. For each entry, runs the same verify → finish → remove sequence.
3. Caps the batch at `recoveryMaxBatch` (default 50) so a long-broken backend doesn't make initialization slow.

### What this rules out

- **Lost purchases when the app crashes after `purchase()` resolves but before `finish()`** — the next launch picks up the transaction.
- **Lost purchases when the network fails mid-verification** — same thing.
- **Lost purchases when the user kills the app during the purchase sheet** — the store hands the transaction to us on next launch, and we recover.

### Note on duplicate `finish()` calls

`cordova-plugin-purchase` is idempotent: calling `finish()` twice on the same transaction is a no-op the second time. The library doesn't rely on this — it removes from storage immediately after `finish()` so the recovery loop won't re-process.

## 3. Backend is the source of truth

**The local entitlement cache is a performance optimization, not a security boundary.**

The cache exists so `iap.hasEntitlement('premium')` can be O(1) — synchronous, safe to call inside reactive computeds. But:

- `iap.refresh()` always re-fetches from `/entitlements` and overwrites the cache.
- The library never extends an expired entitlement based on local clock — `expiresAt` comes from the backend.
- Cache TTL (`entitlementCacheTtlMs`) determines when `initialize()` schedules a background refresh. Reads always return cached values immediately; the refresh runs after `ready` is emitted.

### What this rules out

- **Clock manipulation** — a user setting their device clock backwards doesn't extend their subscription.
- **Stale grants after server-side revocation** — refunds, chargebacks, family-share removals show up on the next refresh (auto-triggered on resume by default).
- **Forged entitlements** — even if a user edits the local Preferences store, the next refresh corrects them.

For reactive UI, subscribe to `entitlements-changed`:

```typescript
iap.on('entitlements-changed', ({ entitlements }) => {
  store.setEntitlements(entitlements);
});
```

Your store reflects backend truth within milliseconds of every refresh.

## 4. Single in-flight purchase per product

**Concurrent `iap.purchase({ productId })` calls for the same product are coalesced.**

If `iap.purchase({ productId: 'premium_monthly' })` is in flight and you call it again, the second call rejects immediately with `IAPError(ALREADY_IN_PROGRESS)`. Different products can purchase in parallel; the same product cannot.

This rules out double-charging when a UI button is rapidly tapped or when navigation re-mounts a paywall component mid-purchase.

## 5. Validated config

**`createIAP(config)` throws synchronously on any structural config error.**

The config schema is enforced via zod. If `backend.baseUrl` is malformed, or `androidPlanId` is missing on a subscription product, `createIAP` throws `IAPError(INVALID_CONFIG)` with field paths — before any native call, before any persistence write. Catch this in dev and print it; it's almost always a typo.

See [Configuration: validation errors](/v5/guide/configuration#validation-errors).

## 6. Type-safe events

**Every event payload is statically checked against `EventMap<TEntitlement>`.**

```typescript
iap.on('entitlements-changed', ({ entitlements, previous }) => {
  // entitlements: TEntitlement[] — your shape
  // previous:     TEntitlement[]
});

iap.on('purchase-success', ({ productId, transaction }) => {
  // productId: string
  // transaction: VerifiedTransaction
});
```

There's no `iap.on('did-something', ...)` escape hatch — unknown event names are a compile error. See [Events](/v5/guide/events) for the full list.

## What we do NOT guarantee

To be honest about the boundaries:

- **No fraud detection** — Attesto validates receipt authenticity; it doesn't catch refund-abuse patterns. That's your backend's problem.
- **No PII handling** — the library passes through receipts and your `EntitlementBase` shape. Anything in `raw` or your custom entitlement fields is your concern.
- **No retry of `verification_failed`** — if the backend explicitly returns `{ valid: false }`, the library does **not** auto-retry (it would just keep failing). The transaction stays in the unfinished queue; you can implement custom retry policy via `iap.refresh()` or by reading `unfinished_transactions` yourself.
- **No paywall gating** — if your UI shows premium content based on `hasEntitlement('premium')` and that returns `true`, it's because the cache or backend says so. Decide what counts as "premium-active" in your backend.

## Next

- [Backend contract](/v5/guide/backend-contract) — exact request/response shapes
- [Error handling](/v5/guide/error-handling) — every `IAPErrorCode` and how to recover
- [Architecture](/v5/guide/architecture) — how the layers compose
