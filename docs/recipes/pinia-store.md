# Pinia store (zoomed in)

This recipe is the typed Pinia store from the [Vue + Quasar recipe](/recipes/vue-quasar) with extra patterns: scoped subscriber, derived state, and a logout hook.

## Setup-style store with typed entitlements

```typescript
// src/stores/iap.ts
import { defineStore } from 'pinia';
import { ref, computed, onScopeDispose, readonly } from 'vue';
import { iap, type AppEntitlement } from 'src/services/iap';
import type { PurchaseResult, RestoreResult } from '@nossdev/iap';

export const useIAPStore = defineStore('iap', () => {
  // ────────────────────────────────────────────────
  // State
  // ────────────────────────────────────────────────
  const entitlements = ref<AppEntitlement[]>([]);
  const isReady = ref(false);
  const isPurchasing = ref(false);
  const isRestoring = ref(false);
  const lastError = ref<string | null>(null);

  // ────────────────────────────────────────────────
  // Subscribers (scoped to store lifetime)
  // ────────────────────────────────────────────────
  const unsubscribers: Array<() => void> = [];

  unsubscribers.push(
    iap.on('entitlements-changed', ({ entitlements: next }) => {
      entitlements.value = next;
    }),
    iap.on('ready', () => {
      entitlements.value = iap.getEntitlements();
      isReady.value = true;
    }),
    iap.on('error', ({ error }) => {
      lastError.value = error.message;
    }),
  );

  onScopeDispose(() => {
    for (const fn of unsubscribers) fn();
  });

  // ────────────────────────────────────────────────
  // Actions
  // ────────────────────────────────────────────────
  async function initialize() {
    if (isReady.value) return;
    await iap.initialize();
    entitlements.value = iap.getEntitlements();
    isReady.value = true;
  }

  async function purchase(productId: string): Promise<PurchaseResult<AppEntitlement>> {
    isPurchasing.value = true;
    lastError.value = null;
    try {
      const result = await iap.purchase({ productId });
      if (result.status === 'failed' || result.status === 'verification_failed') {
        lastError.value = result.error.message;
      }
      return result;
    } finally {
      isPurchasing.value = false;
    }
  }

  async function restore(): Promise<RestoreResult<AppEntitlement>> {
    isRestoring.value = true;
    lastError.value = null;
    try {
      return await iap.restorePurchases();
    } finally {
      isRestoring.value = false;
    }
  }

  async function refresh() {
    await iap.refresh();
  }

  async function teardown() {
    for (const fn of unsubscribers) fn();
    unsubscribers.length = 0;
    await iap.destroy();
    entitlements.value = [];
    isReady.value = false;
  }

  // ────────────────────────────────────────────────
  // Derived selectors
  // ────────────────────────────────────────────────
  const hasPremium = computed(() => entitlements.value.some((e) => e.key === 'premium'));
  const hasEntitlement = (key: string) => computed(() => entitlements.value.some((e) => e.key === key));
  const tier = computed(() =>
    entitlements.value.find((e) => e.key === 'premium')?.tier ?? null,
  );
  const expiresAt = computed(() =>
    entitlements.value.find((e) => e.key === 'premium')?.expiresAt ?? null,
  );
  const adsRemoved = computed(() => entitlements.value.some((e) => e.key === 'remove_ads'));

  // ────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────
  return {
    // state (readonly to consumers — mutations only via actions)
    entitlements: readonly(entitlements),
    isReady: readonly(isReady),
    isPurchasing: readonly(isPurchasing),
    isRestoring: readonly(isRestoring),
    lastError: readonly(lastError),

    // actions
    initialize,
    purchase,
    restore,
    refresh,
    teardown,

    // selectors
    hasPremium,
    hasEntitlement,
    tier,
    expiresAt,
    adsRemoved,
  };
});
```

## Why `readonly()` on state?

Pinia's setup-style stores expose ref-typed state directly — components can technically write to it. Wrapping with `readonly()` enforces "only actions mutate" at the type level, which prevents bugs like:

```typescript
// ❌ A component could do this and bypass the IAP flow:
iapStore.entitlements.value.push({ key: 'premium', /* ... */ });
```

With `readonly`, that's a TypeScript error.

## Logout hook

When the user logs out, you don't want their entitlements visible to the next user:

```typescript
// src/stores/auth.ts (excerpt)
async function logout() {
  await api.logout();
  authToken.value = null;
  await iapStore.teardown();
  await router.replace('/login');
}
```

After login, re-initialize with the new auth token (which `getAuthHeaders()` will pick up automatically):

```typescript
async function login(credentials: LoginInput) {
  const { token } = await api.login(credentials);
  authToken.value = token;
  await iapStore.initialize();
  await router.replace('/');
}
```

`getAuthHeaders()` is called fresh on every backend request, so it'll automatically use the new token without any explicit "rotate" call.

## Selecting one entitlement reactively

The `hasEntitlement` selector returns a computed factory (not a value):

```vue
<script setup lang="ts">
import { useIAPStore } from 'src/stores/iap';

const iapStore = useIAPStore();
const hasPro = iapStore.hasEntitlement('pro_features');
</script>

<template>
  <ProToolsPanel v-if="hasPro" />
</template>
```

This is more memory-efficient than `entitlements.find(...)` in every component — Pinia caches the computed.

## Persistence

Pinia plugins like `pinia-plugin-persistedstate` are NOT needed for entitlements — the IAP library already persists the cache via `@capacitor/preferences`. Persisting Pinia state on top would create a second source of truth that can drift.

If you want app-launch-instant entitlements (before `initialize()` resolves), simply call `iap.getEntitlements()` synchronously — it returns the persisted cache.

## See also

- [Vue + Quasar recipe](/recipes/vue-quasar) — full recipe including paywall and components
- [Events](/guide/events) — what each subscriber handler receives
- [Error handling](/guide/error-handling) — `lastError` strategies
