# Optimistic grant (advanced)

Show premium UI immediately when the native purchase resolves — **before** your backend confirms — then roll back if verification fails. Use sparingly.

::: warning Read this first
Optimistic grant trades **correctness** for **perceived speed**. The library's default behavior is correct: grant entitlements only after backend verification. Use this pattern only when:

1. The verification gap is user-visible (slow backend, slow Attesto path).
2. The cost of a brief false grant is low (cosmetic UI changes, not unlocking irreversible content).
3. You can roll back gracefully without confusing the user.

If your premium UI involves **server-side resources** (API quota, data downloads), stick with the default flow.
:::

## The pattern

Subscribe to `purchase-started`, optimistically push an entitlement into your store, and let `entitlements-changed` (which fires after successful verification) replace it with the real value. If `verification-failed` fires instead, roll back.

## Implementation (Pinia)

```typescript
// src/stores/iap.ts (extending the Pinia store from /recipes/pinia-store)
import type { AppEntitlement } from 'src/services/iap';

const optimisticEntries = ref<Map<string, AppEntitlement>>(new Map());

unsubscribers.push(
  iap.on('purchase-started', ({ productId }) => {
    const optimistic = optimisticEntitlementForProduct(productId);
    if (optimistic) {
      optimisticEntries.value.set(productId, optimistic);
    }
  }),

  iap.on('entitlements-changed', () => {
    // Real entitlements arrived — clear ALL optimistic entries
    // (the backend's response is the new source of truth).
    optimisticEntries.value.clear();
  }),

  iap.on('verification-failed', ({ productId }) => {
    optimisticEntries.value.delete(productId);
  }),

  iap.on('purchase-failed', ({ productId }) => {
    optimisticEntries.value.delete(productId);
  }),

  iap.on('purchase-cancelled', ({ productId }) => {
    optimisticEntries.value.delete(productId);
  }),
);

// Merge real + optimistic for selector
const effectiveEntitlements = computed<AppEntitlement[]>(() => [
  ...entitlements.value,
  ...Array.from(optimisticEntries.value.values()),
]);

const hasPremium = computed(() =>
  effectiveEntitlements.value.some((e) => e.key === 'premium'),
);

function optimisticEntitlementForProduct(productId: string): AppEntitlement | null {
  // Map productId → expected entitlement shape.
  // This MUST match what your backend would return on success.
  switch (productId) {
    case 'premium_monthly':
      return {
        key: 'premium',
        productId,
        expiresAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
        tier: 'pro',
      };
    case 'premium_yearly':
      return {
        key: 'premium',
        productId,
        expiresAt: new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString(),
        tier: 'pro',
      };
    case 'remove_ads':
      return { key: 'remove_ads', productId, expiresAt: null };
    default:
      return null;
  }
}
```

The `effectiveEntitlements` computed is what your UI subscribes to. `hasPremium` becomes `true` the moment the purchase begins, and stays `true` as long as either the optimistic OR the real entitlement is present. The transition from optimistic → real is invisible to the UI (same `key`).

## Critical: roll back gracefully

If `verification-failed` fires, the optimistic entry disappears and `hasPremium` flips back to `false`. Your UI must handle this gracefully:

```vue
<template>
  <PremiumContent v-if="iapStore.hasPremium" />
  <Paywall v-else />
</template>
```

This snaps from premium → paywall if verification fails. Two ways to soften it:

### Option A: warn instead of removing

Keep the optimistic flag for one extra event and show a banner:

```typescript
iap.on('verification-failed', ({ productId }) => {
  // Don't delete immediately; show a banner first
  showVerificationFailureBanner.value = true;
  setTimeout(() => {
    optimisticEntries.value.delete(productId);
    showVerificationFailureBanner.value = false;
  }, 3000);
});
```

### Option B: don't optimistically grant for high-stakes UI

If your "premium" surface is a data download, an API quota bump, or anything else expensive: **don't optimistically grant for those**. Use the optimistic state only for cosmetic changes (badge color, "Premium" label in header).

## What about the `verification-failed` retry case?

`verification-failed` can be transient (backend temporarily down) or permanent (replay attack, sandbox/prod mismatch). The library doesn't auto-retry rejections, but the unfinished transaction stays in the queue and `iap.refresh()` can retry it.

If you want optimistic grants to survive transient failures, gate the rollback on the error code:

```typescript
iap.on('verification-failed', ({ productId, error }) => {
  // Only roll back on definitive rejections, not transient ones
  if (error.code === 'VERIFICATION_REJECTED' || error.code === 'BACKEND_BAD_RESPONSE') {
    optimisticEntries.value.delete(productId);
  }
  // For BACKEND_TIMEOUT / BACKEND_UNAVAILABLE, keep the optimistic entry —
  // the recovery loop will retry on next launch / refresh.
});
```

## Why not just commit optimistically and never roll back?

Don't.

- A user who saw "Premium unlocked!" and then doesn't get billed (because Apple/Google rejected the receipt) will tell their friends "this app gave me free premium". Now you have an exploit.
- A user who saw it and DID get billed but you can't validate the receipt has paid for nothing on your side. They'll chargeback.

The roll-back is non-negotiable. The optimistic UI is a perceived-speed tweak, not a security shortcut.

## Summary

- Subscribe to `purchase-started` to inject an optimistic entry.
- Subscribe to `entitlements-changed` to replace optimistic with real on success.
- Subscribe to `verification-failed`, `purchase-failed`, `purchase-cancelled` to roll back.
- Only optimistically grant for **cosmetic** UI changes; gate server-backed features on real entitlements.
- Be careful with the rollback UX — sudden flips from premium back to paywall confuse users.

## See also

- [Safety guarantees](/guide/safety-guarantees) — why the default flow is the way it is
- [Events](/guide/events) — full event reference
- [Pinia store recipe](/recipes/pinia-store) — base store this pattern extends
