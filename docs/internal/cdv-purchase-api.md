# `cordova-plugin-purchase@13.15.4` API surface

Captured 2026-04-28 from `node_modules/cordova-plugin-purchase/www/store.d.ts`.

## Why this plugin

- **Free + MIT** (vs. RevenueCat, Iaptic which are freemium services)
- **Capacitor 5 compatible** via Cordova bridge — Capacitor 5 ships with native cordova-plugin support; no special wrapper needed
- **Deferred `tx.finish()` is the canonical pattern** — exactly what our safety guarantee needs
- **Active maintenance** — released `13.15.4` on 2026-04-27
- **Production-proven** — used by thousands of App Store / Play Store apps for 10+ years

The trade-off: it's **event-driven**, not promise-based. The adapter encapsulates that.

## Global object

```ts
import 'cordova-plugin-purchase';   // side-effect import; registers cordova plugin
declare const CdvPurchase: typeof import('cordova-plugin-purchase').CdvPurchase;

const store = CdvPurchase.store;     // singleton Store instance
```

Available once the Cordova bridge fires `deviceready`. Capacitor wraps that — `Capacitor.isNativePlatform()` true after `App.addListener('appStateChange', ...)` or simply at runtime after the page loads.

## `Store` (the methods we use)

```ts
class Store {
  // Lifecycle
  register(product: IRegisterProduct | IRegisterProduct[]): void;
  initialize(platforms?: (Platform | PlatformWithOptions)[]): Promise<IError[]>;
  update(): Promise<void>;
  ready(cb: () => void): void;
  get isReady(): boolean;

  // Catalog access (after initialize + update)
  get products(): Product[];
  get(productId: string, platform?: Platform): Product | undefined;

  // Local state
  get localTransactions(): Transaction[];
  owned(product: { id: string; platform?: Platform } | string): boolean;

  // Purchase + restore
  order(offer: Offer, additionalData?: AdditionalData): Promise<IError | undefined>;
  restorePurchases(): Promise<IError | undefined>;
  manageSubscriptions(platform?: Platform): Promise<IError | undefined>;

  // Event chain
  when(): When;
  error(cb: (err: IError) => void): void;
}
```

## `When` chain (the events we use)

```ts
interface When {
  approved(cb: (tx: Transaction) => void, callbackName?: string): When;
  finished(cb: (tx: Transaction) => void, callbackName?: string): When;
  pending(cb: (tx: Transaction) => void, callbackName?: string): When;

  // We don't use these directly; backend does its own validation:
  verified(cb: (r: VerifiedReceipt) => void): When;
  unverified(cb: (r: UnverifiedReceipt) => void): When;
}
```

**No `cancelled()` or `failed()` on `When`.** Cancellation/failure surfaces through:
- The `IError | undefined` returned from `Store.order()` (synchronous fail path)
- `Store.error(cb)` (the global error callback)

A user-cancelled purchase typically appears as `IError` with `code === ErrorCode.PAYMENT_CANCELLED` from `order()`.

## `Transaction`

```ts
class Transaction {
  platform: Platform;
  transactionId: string;
  state: TransactionState;            // INITIATED | PENDING | APPROVED | CANCELLED | FINISHED
  products: { id: string; offerId?: string }[];
  purchaseDate?: Date;
  expirationDate?: Date;
  isAcknowledged?: boolean;
  isPending?: boolean;
  parentReceipt: Receipt;             // Apple: AppleAppStore.Receipt; Google: GooglePlay.Receipt

  finish(): Promise<void>;            // Call AFTER backend verifies
  verify(): Promise<void>;            // We don't call this — backend handles validation
}
```

### Platform-specific transaction extensions

```ts
namespace GooglePlay {
  class Transaction extends CdvPurchase.Transaction {
    nativePurchase: { purchaseToken: string; productIds: string[]; ... };
  }
  class Receipt extends CdvPurchase.Receipt {
    purchaseToken: string;
    orderId?: string;
  }
}
```

For Google verification we need `purchaseToken`:
- Primary source: `(tx as GooglePlay.Transaction).nativePurchase.purchaseToken`
- Fallback: `(tx.parentReceipt as GooglePlay.Receipt).purchaseToken`

For Apple verification we need `transactionId` (numeric string):
- Source: `tx.transactionId` directly

## `IRegisterProduct`

```ts
interface IRegisterProduct {
  id: string;
  type: ProductType;          // see enum below
  platform: Platform;         // APPLE_APPSTORE or GOOGLE_PLAY
  group?: string;             // subscription replacement group
}
```

## Enums

```ts
enum ProductType {
  CONSUMABLE = 'consumable',
  NON_CONSUMABLE = 'non consumable',
  PAID_SUBSCRIPTION = 'paid subscription',
  NON_RENEWING_SUBSCRIPTION = 'non renewing subscription',
  APPLICATION = 'application',
  // FREE_SUBSCRIPTION is deprecated
}

enum Platform {
  APPLE_APPSTORE = 'ios-appstore',
  GOOGLE_PLAY = 'android-playstore',
  TEST = 'test',
  // others not used by us
}

enum TransactionState {
  INITIATED = 'initiated',
  PENDING = 'pending',
  APPROVED = 'approved',
  CANCELLED = 'cancelled',
  FINISHED = 'finished',
  UNKNOWN_STATE = '',
}

enum ErrorCode {
  PAYMENT_CANCELLED,    // user cancelled native sheet
  PAYMENT_INVALID,
  PAYMENT_NOT_ALLOWED,
  PURCHASE,             // generic purchase failure
  // ... ~30 codes total
}
```

## Mapping `@nosslabs/iap` → cdv

| Library `ProductType` | cdv `ProductType` |
|---|---|
| `'subscription'` | `PAID_SUBSCRIPTION` |
| `'product'` | `NON_CONSUMABLE` |
| `'consumable'` | `CONSUMABLE` |

| Library platform | cdv `Platform` |
|---|---|
| `'apple'` | `APPLE_APPSTORE` |
| `'google'` | `GOOGLE_PLAY` |
| `'web'` | (uses WebStubAdapter; no cdv) |

| Library `NativeTransaction.token` | cdv source |
|---|---|
| `platform: 'apple'` | `tx.transactionId` |
| `platform: 'google'` | `(tx as GooglePlay.Transaction).nativePurchase.purchaseToken` (fallback: `(tx.parentReceipt as GooglePlay.Receipt).purchaseToken`) |

## Critical adapter behaviors

### Purchase flow

1. Caller invokes `nativeAdapter.purchaseProduct({ productId, productType, ... })`
2. Adapter looks up the cdv `Product` via `store.get(productId)` → `product.getOffer()`
3. Adapter registers a one-shot `.approved()` listener for that productId **before** calling `order()`
4. Adapter calls `offer.order()`. If it returns `IError`:
   - `code === PAYMENT_CANCELLED` → reject with `IAPError(USER_CANCELLED)`
   - other codes → reject with `IAPError(STORE_ERROR)`
   - removes the `.approved()` listener
5. If `order()` resolves with `undefined`, wait for `.approved()` callback
6. On `.approved(tx)`: capture `tx` in `pendingFinish: Map<token, cdv.Transaction>`, normalize, resolve

The transaction state at `.approved()` is `APPROVED` — **not yet finished**. The adapter does NOT call `tx.finish()` here. That waits for `acknowledge()`.

### Acknowledgement

`adapter.acknowledge(transaction)` looks up the cdv `Transaction` by token in `pendingFinish`, calls `tx.finish()`, removes from the map. Idempotent: if the token isn't in the map (already finished, or unknown), it's a no-op.

### Restore / recovery

`adapter.getOwnedTransactions()` returns:
1. Optionally call `store.restorePurchases()` to force a refresh from native (also re-fires `.approved()` for already-owned items — adapter's persistent `.approved()` listener captures these too)
2. Return `store.localTransactions.filter(tx => tx.state === TransactionState.APPROVED)` mapped to our `NativeTransaction` shape

### Initialization

`adapter.bootstrap()`:
1. Call `store.register(allProducts.map(p => ({ id, type: mapType(p.type), platform: getPlatform() })))`
2. Call `store.initialize([{ platform: APPLE_APPSTORE }, { platform: GOOGLE_PLAY }])` and check IError[]
3. Call `store.update()` to refresh prices
4. Attach a long-lived `.approved()` listener that captures EVERY approved transaction into `pendingFinish` (covers in-flight purchase + restore + out-of-band StoreKit updates)

## Gotchas

- **`.approved()` re-fires after `restorePurchases()`** — owned transactions trigger the callback again. The adapter must handle re-entry idempotently (don't reject the original purchase promise; just stash in `pendingFinish`).
- **No `manageSubscriptions` on iOS in older versions** — `store.checkSupport(Platform.APPLE_APPSTORE, 'manageSubscriptions')` first, fall back to opening App Store URL.
- **`store.update()` has a min-interval** (`store.minTimeBetweenUpdates`, default 60s). Calling rapidly is a no-op.
- **`order()` accepts `additionalData.applicationUsername`** for `appAccountToken` mapping. iOS requires UUID v4 format; Android allows any obfuscated string ≤64 chars.
- **Plugin requires native install step:** `npx cap sync` adds the cordova plugin to iOS/Android projects. Document this in the consumer-facing setup guide (Phase 7).
