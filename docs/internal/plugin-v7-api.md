# `@capgo/native-purchases@7.16.2` API surface

Captured 2026-04-28 from `node_modules/@capgo/native-purchases/dist/esm/definitions.d.ts`.

## Capacitor compatibility

| Plugin range | Capacitor peer |
|---|---|
| `7.13.0` – `7.16.2` | `>=7.0.0` (works on Cap 7 + 8) |
| `7.17.0` – `7.18.0` | `>=8.0.0` (Cap 8 only — labeled "lts-v7" but requires Cap 8) |
| `8.x` | `>=8.0.0` |
| `6.0.x` | `^6.0.0` (Cap 6) |
| `0.0.x` (last 0.0.72) | `^5.0.0` (Cap 5 — versioning was 0.0.x for Cap 5 line) |

**The `1.x` line of `@nosslabs/iap` targets v7.16.2** (last v7 release that's actually Cap-7-compatible). The peer dep is `7.16.x || ^8.0.0` — Cap 8 consumers can move to `@capgo/native-purchases@^8`; Cap 7 consumers stay on `7.16.x`.

## Confirmed methods

```typescript
purchaseProduct(opts: {
  productIdentifier: string;
  planIdentifier?: string;          // Android subscriptions only
  productType?: 'inapp' | 'subs';   // Android only; iOS infers from product
  quantity?: number;                 // iOS only; default 1
  appAccountToken?: string;
  isConsumable?: boolean;            // Android only
  autoAcknowledgePurchases?: boolean;  // default true; SET TO false TO DEFER
}): Promise<Transaction>;

acknowledgePurchase(opts: {
  purchaseToken: string;  // Android: purchaseToken; iOS: transactionId as string
}): Promise<void>;
// Since 7.14.0. Works on BOTH platforms — iOS uses Transaction.finish() under the hood.

getProducts(opts: {
  productIdentifiers: string[];
  productType?: 'inapp' | 'subs';   // Android only
}): Promise<{ products: Product[] }>;

getProduct(opts: {
  productIdentifier: string;
  productType?: 'inapp' | 'subs';
}): Promise<{ product: Product }>;

getPurchases(opts?: {
  productType?: 'inapp' | 'subs';
  appAccountToken?: string;
}): Promise<{ purchases: Transaction[] }>;
// Since 7.2.0.

restorePurchases(): Promise<void>;
// Restores via StoreKit on iOS, Google Play on Android.

manageSubscriptions(): Promise<void>;
// Opens platform's native subscription management UI. Since 7.10.0.

isBillingSupported(): Promise<{ isBillingSupported: boolean }>;

getPluginVersion(): Promise<{ version: string }>;

// Bonus methods (since 7.16.0) — useful for grandfather flows but out of 1.x scope:
getAppTransaction(): Promise<{ appTransaction: AppTransaction }>;
isEntitledToOldBusinessModel(opts: {
  targetVersion?: string;
  targetBuildNumber?: string;
}): Promise<{ isOlderVersion: boolean; originalAppVersion: string }>;
```

## Event listeners (iOS only)

```typescript
addListener('transactionUpdated', (transaction: Transaction) => void): Promise<PluginListenerHandle>;
// Fires on app launch for unfinished transactions, and for any updates afterward.

addListener('transactionVerificationFailed', (payload: TransactionVerificationFailedEvent) => void): Promise<PluginListenerHandle>;
// Fires when StoreKit returns an unverified transaction.

removeAllListeners(): Promise<void>;
```

## Transaction shape (relevant fields)

```typescript
interface Transaction {
  transactionId: string;          // Both platforms
  productIdentifier: string;      // Both platforms
  purchaseDate: string;           // ISO 8601
  purchaseToken?: string;         // Android only — pass to backend for Google validation
  receipt?: string;               // iOS only — base64 StoreKit receipt
  jwsRepresentation?: string;     // iOS, since 7.13.2 — StoreKit 2 JWS
  expirationDate?: string;        // iOS subscriptions
  isActive?: boolean;             // iOS subscriptions
  willCancel: boolean | null;
  subscriptionState?: 'subscribed' | 'expired' | 'revoked' | 'inGracePeriod' | 'inBillingRetryPeriod' | 'unknown';
  purchaseState?: string;         // Android: '1' = PURCHASED, '0' = PENDING
  orderId?: string;               // Android only
  isAcknowledged?: boolean;       // Android only
  ownershipType?: 'purchased' | 'familyShared';  // iOS, since 7.12.8
  environment?: 'Sandbox' | 'Production' | 'Xcode';  // iOS 16+
  appAccountToken?: string | null;
  productType?: 'inapp' | 'subs';
  quantity?: number;
  // ... grace/intro/trial flags
}
```

## Verdict for the `@nosslabs/iap` adapter

✅ **`autoAcknowledgePurchases: false` works on both iOS and Android** — the safety guarantee ("never finish before backend confirms") is fully achievable on v7. The PLAN.md §2.1 honest-limitations section can be **softened**: there is no iOS-specific finish-before-verify race on v7.

✅ `acknowledgePurchase({ purchaseToken })` — single cross-platform method. For iOS, pass the `transactionId` as the `purchaseToken` argument.

✅ `getPurchases()` returns owned transactions for both platforms — replaces the original plan's `syncTransactions()` reference.

✅ Event listeners (`transactionUpdated`, `transactionVerificationFailed`) on iOS are useful for handling out-of-band StoreKit updates (e.g., subscription renewal), but **not wired by the 1.x adapter** — recovery replays from the `unfinished_transactions` store and `refreshOnResume` reconciles server-side renewals. They'd surface as a future additive optional `NativeAdapter` method.

⚠️ **Cap 7 plugin was just deprecated** — v7.16.2 is the last v7 release that actually works on Cap 7 (later 7.x releases require Cap 8). If a critical bug shows up, we fork-and-patch.
