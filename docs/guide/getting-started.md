# Getting started

This page walks you from zero to a working sandbox purchase in under 30 minutes. It assumes you already have:

- A Capacitor 5 app
- Products configured in App Store Connect (sandbox testers OK) and/or Google Play Console (license testers OK)
- A backend you can deploy a few new endpoints to (or you can implement them as a [custom `BackendAdapter`](/api/backend-adapter))
- An [Attesto](https://attesto.nossdev.com) tenant with API key

If you're missing any of these, the [Backend contract](/guide/backend-contract) and [Testing on sandbox](/guide/testing) pages cover them.

## 1. Install

```bash
npm install @nossdev/iap cordova-plugin-purchase
npx cap sync
```

::: tip Optional: app-resume listener
If you want the library to automatically refresh entitlements when your app returns from background (the default), also install `@capacitor/app`:

```bash
npm install @capacitor/app
npx cap sync
```

You can disable this by passing `options.refreshOnResume: false` when creating the IAP instance.
:::

## 2. Create the IAP instance

```typescript
// src/services/iap.ts
import { createIAP } from '@nossdev/iap';
import type { EntitlementBase } from '@nossdev/iap';

// Define your entitlement shape (extends the base).
interface AppEntitlement extends EntitlementBase {
  key: string;            // e.g., 'premium', 'remove_ads'
  productId: string;
  expiresAt: string | null;
  // Add app-specific fields the backend returns:
  tier?: 'basic' | 'pro';
}

export const iap = createIAP<AppEntitlement>({
  products: [
    {
      id: 'premium_monthly',
      type: 'subscription',
      androidPlanId: 'monthly-plan', // required for Android subs
    },
    { id: 'remove_ads', type: 'product' },
  ],
  backend: {
    baseUrl: 'https://api.your-app.com',
    endpoints: {
      verifyApple: '/api/iap/verify/apple',
      verifyGoogle: '/api/iap/verify/google',
      entitlements: '/api/iap/entitlements',
      restore: '/api/iap/restore',
    },
    getAuthHeaders: async () => ({
      Authorization: `Bearer ${await getAuthToken()}`,
    }),
  },
});
```

The factory validates your config with zod and throws `IAPError(INVALID_CONFIG)` on any structural issue — no surprises at runtime.

## 3. Initialize after auth is ready

```typescript
// src/main.ts (or wherever your app boots)
import { iap } from './services/iap';

await iap.initialize();
```

`initialize()` does the following:

1. Loads any cached entitlements from local storage (instant warm cache)
2. Recovers any unfinished transactions from prior sessions
3. Wires the app-resume listener (if `refreshOnResume`)
4. Schedules a background refresh if cache exceeds TTL
5. Emits `ready`

After `initialize()` returns, all read methods (`hasEntitlement`, `getEntitlements`, `getEntitlement`, `getProducts`) are safe to call.

## 4. Buy something

```typescript
const result = await iap.purchase({ productId: 'premium_monthly' });

switch (result.status) {
  case 'success':
    // Backend has validated. Entitlements are already updated in state.
    console.log('Welcome to premium!');
    break;
  case 'cancelled':
    // User dismissed the native purchase sheet.
    break;
  case 'pending':
    // Android: payment awaiting external clearance (e.g. cash).
    console.log('Payment is processing. We\'ll notify you when it clears.');
    break;
  case 'verification_failed':
    // Backend rejected, transport error, etc. The unfinished entry stays
    // for retry; library will auto-recover on next launch / refresh.
    console.error('Verification failed:', result.error.message);
    break;
  case 'failed':
    // Native error (network, store error, etc.). User can try again.
    console.error('Purchase failed:', result.error.message);
    break;
}
```

The discriminated union is by design — UI code decides what to show without needing try/catch around every call.

### Pre-attaching a user identifier (optional)

If your app has a logged-in user at purchase time, pass an `appUserId` so it
travels through StoreKit / Play Billing and reaches your backend on both the
verify response and the eventual webhook. Eliminates the verify/webhook race
on the backend side — see [Attesto's integration guide](https://attesto.nossdev.com/guide/integration#mapping-webhook-events-back-to-users)
for the join pattern.

```typescript
// (a) Plain string — your app already has the UUID.
await iap.purchase({
  productId: 'premium_monthly',
  appUserId: currentUser.iapUuid,
});

// (b) Async fetcher — your backend mints+saves the UUID per user the first
//     time it's asked, returns the same UUID on later calls. iap calls the
//     fetcher fresh on every purchase; backend owns the idempotency.
await iap.purchase({
  productId: 'premium_monthly',
  appUserId: async () => {
    const r = await fetch('/api/iap/uuid', { headers: authHeaders() });
    return (await r.json()).uuid;
  },
});
```

The supplied value (literal or fetcher-returned) **must be a UUID v4**. iap
validates before passing to native; non-UUIDs throw `IAPError(INVALID_APP_USER_ID)`.
Apple requires UUIDs for `appAccountToken`; we enforce the same on Android
for a consistent contract.

For purchases without a logged-in user (guest flows), simply omit
`appUserId` — your backend falls back to mapping by Attesto's `subject.key`
(see the integration guide).

## 5. Read entitlements anywhere

```typescript
// Synchronous reads from the in-memory cache
if (iap.hasEntitlement('premium')) {
  showPremiumFeatures();
}

const allEntitlements = iap.getEntitlements();
// → [{ key: 'premium', productId: 'premium_monthly', expiresAt: '...', ... }]

const premium = iap.getEntitlement('premium');
// → AppEntitlement | null
```

These reads are O(1) on a frozen array. Safe to call inside reactive computeds — they don't trigger network.

## 6. React to changes

```typescript
const unsubscribe = iap.on('entitlements-changed', ({ entitlements, previous }) => {
  // Wire to your store / state management.
  store.setEntitlements(entitlements);
});

// Later, when tearing down:
unsubscribe();
```

See [Vue + Quasar recipe](/recipes/vue-quasar) and [React recipe](/recipes/react) for full reactive store wiring.

## 7. Restore on a new device

```typescript
// Wire to a "Restore Purchases" button.
async function onRestoreClick() {
  try {
    const { restored, entitlements } = await iap.restorePurchases();
    if (restored === 0) {
      alert('No previous purchases found.');
    } else {
      alert(`Restored ${restored} purchase(s).`);
    }
  } catch (error) {
    alert(`Restore failed: ${error.message}`);
  }
}
```

`restorePurchases()` calls `getOwnedTransactions()` natively, batches to your backend's `/restore` endpoint, and updates entitlements from the consolidated response.

## What's next

- [Backend contract](/guide/backend-contract) — implement the four endpoints in your backend (Attesto handles the receipt validation)
- [Configuration](/guide/configuration) — full schema reference
- [Error handling](/guide/error-handling) — all `IAPErrorCode` values and remediation hints
- [Testing on sandbox](/guide/testing) — sandbox tester accounts on iOS + Google license testers on Android
