# Vue 3 + Quasar + Pinia

This recipe wires `@nossdev/iap` into a Vue 3 / Quasar / Pinia app — the stack the library was designed against. End-to-end: factory creation, Pinia store, paywall component, restore button.

## 1. Create the IAP instance

```typescript
// src/services/iap.ts
import { createIAP } from '@nossdev/iap';
import type { EntitlementBase } from '@nossdev/iap';

export interface AppEntitlement extends EntitlementBase {
  key: string;
  productId: string;
  expiresAt: string | null;
  tier?: 'basic' | 'pro';
}

export const iap = createIAP<AppEntitlement>({
  products: [
    { id: 'premium_monthly', type: 'subscription', androidPlanId: 'monthly-plan' },
    { id: 'premium_yearly', type: 'subscription', androidPlanId: 'yearly-plan' },
    { id: 'remove_ads', type: 'product' },
  ],
  backend: {
    baseUrl: import.meta.env.VITE_API_URL,
    endpoints: {
      verifyApple: '/api/iap/verify/apple',
      verifyGoogle: '/api/iap/verify/google',
      entitlements: '/api/iap/entitlements',
      restore: '/api/iap/restore',
    },
    getAuthHeaders: async () => {
      const { getToken } = useAuth();   // your auth composable
      return { Authorization: `Bearer ${await getToken()}` };
    },
  },
});
```

## 2. Pinia store

```typescript
// src/stores/iap.ts
import { defineStore } from 'pinia';
import { ref, computed, onScopeDispose } from 'vue';
import { iap, type AppEntitlement } from 'src/services/iap';

export const useIAPStore = defineStore('iap', () => {
  const entitlements = ref<AppEntitlement[]>([]);
  const isReady = ref(false);
  const isPurchasing = ref(false);

  // Subscribe to library events. Pinia stores live for the app lifetime,
  // so we don't unsubscribe — but we use onScopeDispose to be tidy in HMR.
  const unsubscribeChanged = iap.on('entitlements-changed', ({ entitlements: next }) => {
    entitlements.value = next;
  });

  const unsubscribeReady = iap.on('ready', () => {
    entitlements.value = iap.getEntitlements();
    isReady.value = true;
  });

  onScopeDispose(() => {
    unsubscribeChanged();
    unsubscribeReady();
  });

  async function initialize() {
    await iap.initialize();
    entitlements.value = iap.getEntitlements();
    isReady.value = true;
  }

  async function purchase(productId: string) {
    isPurchasing.value = true;
    try {
      return await iap.purchase(productId);
    } finally {
      isPurchasing.value = false;
    }
  }

  async function restore() {
    return iap.restorePurchases();
  }

  // Reactive selectors
  const hasPremium = computed(() => entitlements.value.some((e) => e.key === 'premium'));
  const tier = computed(() => entitlements.value.find((e) => e.key === 'premium')?.tier ?? null);
  const adsRemoved = computed(() => entitlements.value.some((e) => e.key === 'remove_ads'));

  return {
    entitlements,
    isReady,
    isPurchasing,
    initialize,
    purchase,
    restore,
    hasPremium,
    tier,
    adsRemoved,
  };
});
```

::: tip Why subscribe in the store and not the boot file?
Subscribing in the store keeps the data flow co-located: the store is the single owner of "what's the current entitlement state", and components only depend on the store. If you subscribe at boot and write directly into the store, two callers can race.
:::

## 3. Boot the IAP layer

```typescript
// src/boot/iap.ts
import { boot } from 'quasar/wrappers';
import { useIAPStore } from 'src/stores/iap';

export default boot(async ({ store }) => {
  const iapStore = useIAPStore(store);

  // Don't `await` — let the app render with cached entitlements while
  // initialize() hydrates in the background. Components reactive to
  // `isReady` can show their own loading state.
  iapStore.initialize().catch((err) => {
    console.error('IAP init failed', err);
  });
});
```

Register in `quasar.config.ts`:

```typescript
boot: ['iap'],
```

## 4. Paywall component

```vue
<!-- src/components/Paywall.vue -->
<template>
  <q-card class="paywall">
    <q-card-section>
      <div class="text-h5">Upgrade to Premium</div>
      <div class="text-subtitle1">Unlock everything.</div>
    </q-card-section>

    <q-card-actions align="right">
      <q-btn
        :loading="iapStore.isPurchasing"
        :disable="iapStore.hasPremium"
        color="primary"
        label="Subscribe — $4.99/month"
        @click="onPurchase"
      />
    </q-card-actions>
  </q-card>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar';
import { useIAPStore } from 'src/stores/iap';
import { isIAPError, IAPErrorCode } from '@nossdev/iap';

const $q = useQuasar();
const iapStore = useIAPStore();

async function onPurchase() {
  const result = await iapStore.purchase('premium_monthly');

  switch (result.status) {
    case 'success':
      $q.notify({ type: 'positive', message: 'Welcome to Premium!' });
      break;
    case 'cancelled':
      // Silent — user dismissed the sheet
      break;
    case 'pending':
      $q.notify({
        type: 'info',
        message: 'Payment processing — we\'ll grant access when it clears.',
      });
      break;
    case 'verification_failed':
      $q.notify({
        type: 'warning',
        message: 'We couldn\'t verify your purchase. We\'ll retry shortly.',
      });
      break;
    case 'failed':
      $q.notify({ type: 'negative', message: `Purchase failed: ${result.error.message}` });
      break;
  }
}
</script>
```

## 5. Restore button

```vue
<!-- src/components/RestoreButton.vue -->
<template>
  <q-btn flat label="Restore Purchases" :loading="loading" @click="onRestore" />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useQuasar } from 'quasar';
import { useIAPStore } from 'src/stores/iap';

const $q = useQuasar();
const iapStore = useIAPStore();
const loading = ref(false);

async function onRestore() {
  loading.value = true;
  try {
    const { restored } = await iapStore.restore();
    $q.notify({
      type: 'positive',
      message: restored === 0
        ? 'No previous purchases found.'
        : `Restored ${restored} purchase(s).`,
    });
  } catch (error) {
    $q.notify({ type: 'negative', message: `Restore failed: ${(error as Error).message}` });
  } finally {
    loading.value = false;
  }
}
</script>
```

## 6. Conditional UI based on entitlements

```vue
<template>
  <q-page>
    <FreeContent />

    <!-- Only render premium content when the user has it -->
    <PremiumContent v-if="iapStore.hasPremium" />

    <!-- Only show ads when the user hasn't bought remove_ads -->
    <AdBanner v-if="!iapStore.adsRemoved" />

    <!-- Tier-specific content -->
    <ProTools v-if="iapStore.tier === 'pro'" />
  </q-page>
</template>

<script setup lang="ts">
import { useIAPStore } from 'src/stores/iap';
const iapStore = useIAPStore();
</script>
```

These reads are O(1) and reactive — no network calls, no async, just computed refs against the in-memory cache. The cache stays fresh because the library auto-refreshes on app resume (`refreshOnResume: true` by default).

## Cleanup

Quasar boot files run for the app lifetime, so no explicit `iap.destroy()` is needed. If your app has a logout flow that should clear entitlements, call:

```typescript
// On logout:
await iap.destroy();
// To re-init for the next user, they'll need to navigate to a screen that
// re-creates the IAP instance. Easiest: restart the app or re-call createIAP().
```

::: tip Multi-user apps
If users sign in and out of the same app session, prefer NOT calling `destroy()` on logout — instead, clear the cache by calling `iap.refresh()` after the new user authenticates (different `getAuthHeaders()` will return their entitlements). The factory is meant to be created once per process.
:::

## See also

- [React recipe](/recipes/react) — same patterns with hooks
- [Pinia store](/recipes/pinia-store) — typed store with subscriber pattern (zoomed-in)
- [Optimistic grant](/recipes/optimistic-grant) — show premium UI before backend confirms
