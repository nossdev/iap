# `@capgo/native-purchases@7.16.2` API surface

Captured 2026-04-28 from `node_modules/@capgo/native-purchases/dist/esm/definitions.d.ts`.

## Capacitor compatibility

| Plugin range | Capacitor peer |
|---|---|
| `7.13.0` – `7.16.2` | `>=7.0.0` (works on Cap 7 + 8) |
| `7.17.0` – `7.18.0` | `>=8.0.0` (Cap 8 only — a regression; these briefly carried the `lts-v7` tag) |
| `7.19.1` – `7.19.3` | `>=7.0.0` (Cap-7 compatible again; `lts-v7` currently resolves here) |
| `8.x` | `>=8.0.0` |
| `6.0.x` | `^6.0.0` (Cap 6) |
| `0.0.x` (last 0.0.72) | `^5.0.0` (Cap 5 — versioning was 0.0.x for Cap 5 line) |

**The `7.x` line of `@nosslabs/iap` declares `^7.16.2`**, which admits the whole
Cap-7-compatible range including `7.19.x`. Its peer dep was historically
`7.16.x || ^8.0.0`, narrowed to `^7.16.2` for the `7.1.0` release. Cap 7
consumers should install from the plugin's `lts-v7` dist-tag, which currently
resolves to `7.19.3` (peer `>=7.0.0`). The `8.x` line of `@nosslabs/iap`
requires `@capgo/native-purchases@^8`.

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

// Bonus methods (since 7.16.0) — useful for grandfather flows but out of 7.x scope:
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

✅ Event listeners (`transactionUpdated`, `transactionVerificationFailed`) on iOS are useful for handling out-of-band StoreKit updates (e.g., subscription renewal), but **not wired by the 7.x adapter** — recovery replays from the `unfinished_transactions` store and `refreshOnResume` reconciles server-side renewals. They'd surface as a future additive optional `NativeAdapter` method.

⚠️ **Cap-7 support wobbled but was restored.** `7.17.0`–`7.18.0` shipped a
`>=8.0.0` peer, briefly making the `lts-v7` tag Cap-8-only. `7.19.1` and
`7.19.3` reverted to `>=7.0.0`, and `lts-v7` now resolves to `7.19.3`. Recheck
`npm view @capgo/native-purchases@lts-v7 peerDependencies` before relying on the
tag; if it regresses again, pin `7.19.3` explicitly or fork-and-patch.
