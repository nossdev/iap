# React

This recipe wires `@nosslabs/iap` into a React 18+ app using `useSyncExternalStore` — the modern idiom for subscribing to external state without dual-bookkeeping.

## 1. Create the IAP instance (singleton)

```typescript
// src/services/iap.ts
import { createIAP } from '@nosslabs/iap';
import type { EntitlementBase } from '@nosslabs/iap';

export interface AppEntitlement extends EntitlementBase {
  key: string;
  productId: string;
  expiresAt: string | null;
  tier?: 'basic' | 'pro';
}

export const iap = createIAP<AppEntitlement>({
  // SKU manifest fetched from the backend during initialize().
  // See docs/guide/backend-contract#products-optional for the response shape.
  backend: {
    baseUrl: import.meta.env.VITE_API_URL,
    endpoints: {
      verifyApple: '/api/iap/verify/apple',
      verifyGoogle: '/api/iap/verify/google',
      entitlements: '/api/iap/entitlements',
      restore: '/api/iap/restore',
      products: '/api/iap/products',
    },
    getAuthHeaders: async () => ({
      Authorization: `Bearer ${await getAuthToken()}`,
    }),
  },
});
```

::: tip Backend-driven manifest
The backend returns the SKU list during `initialize()` so you can feature-flag, A/B-test, or region-gate SKUs without an app release. Every id MUST still be pre-registered in App Store Connect / Google Play Console. Prefer a static array? Pass `products: [...]` — see [Configuration → products](/guide/configuration#products).
:::

## 2. `useEntitlements` hook

```typescript
// src/hooks/useEntitlements.ts
import { useSyncExternalStore } from 'react';
import { iap, type AppEntitlement } from '../services/iap';

export function useEntitlements(): AppEntitlement[] {
  return useSyncExternalStore(
    (onChange) => iap.on('entitlements-changed', onChange),
    () => iap.getEntitlements(),
    () => [], // SSR fallback
  );
}

export function useHasEntitlement(key: string): boolean {
  const entitlements = useEntitlements();
  return entitlements.some((e) => e.key === key);
}

export function useEntitlement(key: string): AppEntitlement | null {
  const entitlements = useEntitlements();
  return entitlements.find((e) => e.key === key) ?? null;
}
```

`useSyncExternalStore` handles concurrent rendering correctly — no torn renders, no extra state. The library's emitter is the source of truth; React just subscribes.

## 3. `useIAPReady` hook

```typescript
// src/hooks/useIAPReady.ts
import { useEffect, useState } from 'react';
import { iap } from '../services/iap';

export function useIAPReady() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    iap.initialize().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  return ready;
}
```

Mount this at your app root (or a top-level provider component). `initialize()` is idempotent if accidentally called twice during HMR / strict-mode double-effect.

## 4. Boot in your app root

```tsx
// src/App.tsx
import { useIAPReady } from './hooks/useIAPReady';
import { Routes } from './routes';
import { Spinner } from './components/Spinner';

export function App() {
  const iapReady = useIAPReady();

  if (!iapReady) return <Spinner />;
  return <Routes />;
}
```

If you want to render before init resolves (using cached entitlements), skip the `<Spinner />` — entitlement reads work even before `ready` (they return `[]` until the cache hydrates, then snap to real values within ~10ms).

## 5. Paywall component

```tsx
// src/components/Paywall.tsx
import { useState } from 'react';
import { iap } from '../services/iap';
import { useHasEntitlement } from '../hooks/useEntitlements';

export function Paywall() {
  const isPremium = useHasEntitlement('premium');
  const [purchasing, setPurchasing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onPurchase() {
    setPurchasing(true);
    setMessage(null);

    const result = await iap.purchase({ productId: 'premium_monthly' });

    switch (result.status) {
      case 'success':
        setMessage('Welcome to Premium!');
        break;
      case 'cancelled':
        break;
      case 'pending':
        setMessage('Payment processing — we\'ll grant access when it clears.');
        break;
      case 'verification_failed':
        setMessage('We couldn\'t verify your purchase. We\'ll retry shortly.');
        break;
      case 'failed':
        setMessage(`Purchase failed: ${result.error.message}`);
        break;
    }

    setPurchasing(false);
  }

  return (
    <div className="paywall">
      <h2>Upgrade to Premium</h2>
      <button onClick={onPurchase} disabled={purchasing || isPremium}>
        {isPremium ? 'You\'re Premium' : 'Subscribe — $4.99/month'}
      </button>
      {message && <p>{message}</p>}
    </div>
  );
}
```

## 6. Restore button

```tsx
// src/components/RestoreButton.tsx
import { useState } from 'react';
import { iap } from '../services/iap';

export function RestoreButton() {
  const [loading, setLoading] = useState(false);

  async function onRestore() {
    setLoading(true);
    try {
      const { restored } = await iap.restorePurchases();
      alert(restored === 0 ? 'No previous purchases.' : `Restored ${restored} purchase(s).`);
    } catch (error) {
      alert(`Restore failed: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button onClick={onRestore} disabled={loading}>
      {loading ? 'Restoring…' : 'Restore Purchases'}
    </button>
  );
}
```

## 7. Conditional UI

```tsx
import { useHasEntitlement, useEntitlement } from './hooks/useEntitlements';

export function HomePage() {
  const isPremium = useHasEntitlement('premium');
  const adsRemoved = useHasEntitlement('remove_ads');
  const premium = useEntitlement('premium');

  return (
    <div>
      <FreeContent />
      {isPremium && <PremiumContent />}
      {!adsRemoved && <AdBanner />}
      {premium?.tier === 'pro' && <ProTools />}
    </div>
  );
}
```

## React Native / Capacitor on web

This recipe is for **Capacitor + React** (running in a WebView on iOS/Android). It also works in plain React (no Capacitor) — the library detects web and falls back to no-op for purchases while keeping reads functional. Useful for Storybook, dev servers, etc.

## Cleanup

`useSyncExternalStore` handles its own subscription cleanup. The IAP instance is a long-lived singleton; don't `iap.destroy()` on component unmount — only on app teardown / logout.

## See also

- [Vue + Quasar recipe](/recipes/vue-quasar) — Pinia store wiring
- [Optimistic grant](/recipes/optimistic-grant) — show premium UI before backend confirms
- [Events](/guide/events) — what `entitlements-changed` and other events deliver
