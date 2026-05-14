# @nossdev/iap — In-App Purchase Wrapper for Capacitor

> **Handoff document for Claude Code.** This is the complete plan for building `@nossdev/iap` from scratch. Read this file in full before starting implementation.

---

## 1. Project Summary

**`@nossdev/iap`** is a thin, framework-agnostic TypeScript library that orchestrates the in-app purchase flow on the client side. It wraps `cordova-plugin-purchase` on Capacitor 5 (the v0.1.0 target; `@capgo/native-purchases` is the planned Cap 7+ successor) and coordinates with **your client's backend** — which in turn talks to **Attesto** for receipt validation.

This is the client-side counterpart to [Attesto](https://attesto.nossdev.com). Attesto answers *"is this transaction real?"* on the server. `@nossdev/iap` answers *"how do we orchestrate the purchase flow and entitlement state cleanly on the client?"*

- **Package name:** `@nossdev/iap`
- **GitHub:** `nossdev/iap`
- **License:** MIT
- **Distribution:** public npm + GitHub Packages mirror (`@nossdev` org)
- **Initial Capacitor target:** **Capacitor 5** (Infopathy production app — bundle id `com.ashnutech.infopathy.app` — is on Cap 5 and the IAP integration is the last blocker for store approval; Cap 6/7/8 support deferred to v1.x via additional adapters)

### Why it exists

Without this library, every Capacitor app reimplements the same orchestration pattern:

1. Call native plugin to start purchase
2. Receive transaction token from native side
3. Optimistically grant access in UI
4. Send token to your backend for validation
5. Wait for backend response
6. **Only after backend confirms**, acknowledge / finish the transaction on the plugin
7. Update local entitlement cache
8. Emit events so UI can react
9. Handle restore flow
10. Handle pending / interrupted transactions on app launch
11. Persist entitlement state to survive app restarts

That's a lot of orchestration. The library encapsulates it once, correctly, and makes it consumable across all Night Owl apps and client apps.

### How the Attesto integration actually flows

Attesto exposes two split endpoints — `POST /v1/apple/verify` (request: `{ transactionId, environment? }`) and `POST /v1/google/verify` (request: `{ packageName, productId, purchaseToken, type }`) — both authenticated with `Authorization: Bearer <api_key>`. They return normalized transactions: Apple's response includes `bundleId`, `productId`, `expiresDate`, `inAppOwnershipType`, `revocationDate`, etc.; Google's response is keyed by `kind` (`"androidpublisher#subscriptionPurchaseV2"` or `"androidpublisher#productPurchase"`). Attesto also forwards verified webhooks (App Store SSN V2 + Google RTDN) to the consumer's registered callback URL with HMAC-SHA256 signatures.

`@nossdev/iap` never sees Attesto. It calls the consumer's backend, which in turn calls Attesto. The library's recommended backend contract (§5.8) deliberately mirrors Attesto's split-by-platform shape so the consumer's translation layer is thin.

### Design philosophy: **Thin wrapper, not a framework**

`@nossdev/iap` is **NOT** RevenueCat-on-the-client. It does **one thing**: orchestrate the purchase + verification + entitlement-caching dance against a backend you control.

**`@nossdev/iap` DOES:**
- Wrap `cordova-plugin-purchase` (Cap 5) for purchase + restore flows
- POST to a configurable backend endpoint for verification
- Acknowledge / finish transactions only after backend confirms validation (with platform caveats — see §2.1)
- Cache entitlements locally (via Capacitor Preferences) for fast reads
- Emit events for UI reactivity (`entitlements-changed`, `purchase-success`, etc.)
- Handle pending transactions on app resume / launch
- Provide a clean Promise-based API
- Be framework-agnostic (works with Vue/Quasar, React, Svelte, vanilla TS)

**`@nossdev/iap` does NOT:**
- Talk to Attesto directly (your backend does)
- Implement receipt validation logic (Attesto does)
- Define entitlement business rules (your backend does)
- Manage user authentication (your app does)
- Provide UI components (paywalls, product cards, etc.)
- Render product names or prices (consumer is responsible for UI)
- Handle promo codes, offer codes, A/B testing
- Replace the underlying Capacitor plugin's capabilities — it composes on top

**This boundary is non-negotiable.** If a feature request starts encroaching on entitlement business logic or paywall UI, push back — that belongs in the consumer app, not this library.

---

## 2. Critical Constraints

### Capacitor 5 target + plugin choice

The native plugin for v0.1.0 is **[`cordova-plugin-purchase`](https://github.com/j3k0/cordova-plugin-purchase)** (also published as `iap-2` and accessed as the `CdvPurchase` namespace), pinned to `^13.0.0`. Capacitor 5 supports Cordova plugins natively, so consumers install via `npm install cordova-plugin-purchase` and `npx cap sync`.

The library's peer dep range is `@capacitor/core: ^5.0.0`, `@capacitor/preferences: ^5.0.0`, `cordova-plugin-purchase: ^13.0.0`.

Why not `@capgo/native-purchases`? The v5-compatible release of that plugin (`0.0.72`, the only release in its `0.0.x` line that targets `@capacitor/core: ^5.0.0`) **lacks `acknowledgePurchase` and the `autoAcknowledgePurchases: false` parameter** — those were introduced in v7.14.0. v0.0.72 auto-finishes every purchase, which breaks the safety guarantee. (See `docs/internal/_future/plugin-v7-api.md` for the v7 plugin's surface — relevant for the future Cap 7 migration.)

Why cordova-plugin-purchase? Free MIT, last release 2026-04-27 (active maintenance), production-proven across thousands of App Store / Play Store apps for 10+ years, and its canonical pattern is `store.when().approved(tx => verifyOnServer(tx).then(() => tx.finish()))` — exactly the deferred-ack flow the library needs. Trade-off: event-driven instead of Promise-based, but the adapter encapsulates that.

Practical consequences:

- **Cordova-plugin-purchase is the only IAP plugin we install at the native layer.** When the consumer migrates to Capacitor 7+, the library swaps the cdv adapter for the v7 adapter (preserved in git commit `f1d20ed`); the public API doesn't change.
- **The library is built to be Capacitor-version-agnostic via a thin internal adapter** (see §4.1). Future v6/7/8 adapters re-implement only that contract; the core flows and public API are unchanged.
- **A support matrix in the README** documents which `@nossdev/iap` version pairs with which Capacitor + plugin version (§11).

### 2.1 cordova-plugin-purchase behavior the library relies on

Phase 1's first task — captured in `docs/internal/cdv-purchase-api.md` — documents the actual plugin surface. Key facts the library depends on:

- **`Transaction.finish()` is called manually**, not automatically. The `.approved()` callback fires when the user completes a purchase; the transaction stays in the `APPROVED` state until the consumer code calls `tx.finish()`. This gives the library full control over when ack happens.
- **`store.order(offer)`** returns `Promise<IError | undefined>` — `IError` with `code === ErrorCode.PAYMENT_CANCELLED` is the cancellation signal (the `.when()` chain doesn't have a `.cancelled()` callback).
- **`store.localTransactions`** is the source for restore + recovery; `store.restorePurchases()` triggers a refresh and re-fires `.approved()` for owned items.
- **`store.register()`** is called once per session with the configured product catalog; `store.initialize([platform])` connects to the native platform; `store.update()` refreshes prices.
- **`CdvPurchase` is exposed as a global namespace** (the plugin attaches to `window.CdvPurchase` at load time). The adapter accesses it via `globalThis.CdvPurchase` after a side-effect import of `cordova-plugin-purchase`.

**Safety guarantee (full on Cap 5):**
On both iOS and Android, the library captures the cdv `Transaction` object inside the `.approved()` callback **without** calling `tx.finish()`. The transaction is staged in an internal `pendingFinish: Map<token, Transaction>`. Only after backend verification succeeds does the core flow call `nativeAdapter.acknowledge(transaction)`, which looks up the cdv transaction in the map and calls `tx.finish()`.

If the app dies between native success and ack, or if the backend rejects the transaction, the transaction stays unacknowledged: Google auto-refunds Android purchases after 3 days; iOS keeps the transaction in the StoreKit queue, replayed via `.approved()` on the next launch (the long-lived adapter listener captures it). Recovery on `initialize()` re-attempts verification via `unfinished_transactions` storage.

The "never grant before backend confirms" promise holds end-to-end.

### Platform requirements (inherited from `cordova-plugin-purchase`)

- **iOS:** 15.0+ (StoreKit 2 requires iOS 15)
- **Android:** API 21+ (Android 5.0+), Google Play Billing 7.x

If a consumer app needs to support iOS < 15, this library is not for them.

### Web platform

`cordova-plugin-purchase` only exists on iOS and Android (and other native platforms via Cordova; web is unsupported). On web, the library exposes a **no-op / stub native adapter** so consumer apps can render development UIs without crashing. Storage and entitlement reads still work on web (see §9).

---

## 3. Tech Stack (Finalized)

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5.x | Type safety, modern features |
| Build | **tsup** | Fast, dual ESM/CJS output, zero-config |
| Package format | Dual ESM + CJS with `.d.ts` | Maximum compatibility |
| Test runner | **vitest** | Fast, modern, Vite-based; works for pure TS libs |
| Lint / format | **biome** | Faster than eslint+prettier, single tool |
| Native plugin (peer) | `cordova-plugin-purchase` (^13) on Cap 5; `@capgo/native-purchases` is the planned successor for Cap 7+ | The actual native bridge |
| Capacitor (peer) | `@capacitor/core`, `@capacitor/preferences` | Storage + platform detection |
| Validation | **zod 3** | Runtime config validation. zod 4 upgrade tracked as TODO in CHANGELOG. |
| HTTP | Native `fetch` | Standard, no extra deps |

### Key dependency boundaries

```
@nossdev/iap
├── peerDependencies (consumer must install)
│   ├── @capacitor/core (^5)
│   ├── @capacitor/preferences (^5)
│   └── cordova-plugin-purchase (^13)
├── dependencies
│   └── zod (^3.23.0)
└── devDependencies
    ├── typescript
    ├── tsup
    ├── vitest
    └── ... (tooling)
```

`cordova-plugin-purchase` is a **peer dependency** so the consumer controls which version they install (and so that `npx cap sync` picks it up at the native layer). The library has internal adapter code that paper over plugin API differences when Cap 7+ adapters are added later.

---

## 4. Architecture

### Three-tier model

```
┌──────────────────────────────────────────────────────┐
│                                                       │
│  Consumer App (Vue / Quasar / React / Svelte)         │
│   ↕                                                   │
│   await iap.purchase('premium_monthly')               │
│   iap.hasEntitlement('premium')                       │
│   iap.on('entitlements-changed', ...)                 │
│                                                       │
└──────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│                                                       │
│  @nossdev/iap (THIS LIBRARY)                          │
│  ─────────────                                        │
│   - Orchestrates purchase flow                        │
│   - Coordinates with backend                          │
│   - Manages entitlement cache                         │
│   - Emits reactive events                             │
│                                                       │
└──────────────────────────────────────────────────────┘
              │                            │
              ▼                            ▼
┌─────────────────────────┐    ┌─────────────────────────┐
│ cordova-plugin-purchase │    │ Consumer's backend      │
│ (native bridge)         │    │ (HTTP API)              │
│ → StoreKit 2 / Billing  │    │ → calls Attesto         │
└─────────────────────────┘    └─────────────────────────┘
                                            │
                                            ▼
                                ┌─────────────────────────┐
                                │ Attesto                 │
                                │ (receipt validation)    │
                                └─────────────────────────┘
```

**Key architectural rules:**

1. **The library NEVER calls Attesto directly.** Attesto API keys are server credentials. The library only calls the consumer's backend. The consumer's backend calls Attesto.
2. **The backend is the source of truth for entitlements.** The library caches them locally for performance, but always defers to backend state on refresh.
3. **Acknowledgement only happens AFTER backend validation succeeds** — fully on Android (deferred ack), best-effort on iOS v5 (transaction is auto-finished by StoreKit 2; see §2.1).
4. **Web platform is a no-op stub.** Consumers can develop UI on web without crashes.

### 4.1 Native adapter contract

Every Capacitor-major-specific adapter implements the same `NativeAdapter` interface. The core flows in `src/core/*` only see this interface; no plugin types leak past `src/adapters/native/`.

```typescript
// src/adapters/native/types.ts
export interface NativeAdapter {
  isAvailable(): Promise<boolean>;

  getProducts(productIds: string[]): Promise<NativeProduct[]>;

  purchaseProduct(opts: {
    productId: string;
    androidPlanId?: string;
    productType: 'subscription' | 'product' | 'consumable';
    appAccountToken?: string;
  }): Promise<NativeTransaction>;

  /** Get all currently-owned transactions for restore + recovery. */
  getOwnedTransactions(): Promise<NativeTransaction[]>;

  /**
   * Acknowledge / finish a transaction post-verification.
   * No-op on platforms where the plugin auto-finishes (iOS v5 StoreKit 2).
   * The adapter MUST silently succeed if it can't defer finishing —
   *   core flow logs a debug-level note when ack is a no-op.
   */
  acknowledge(transaction: NativeTransaction): Promise<void>;
}

export interface NativeProduct {
  id: string;
  title: string;
  description: string;
  priceString: string;     // localized: "$4.99"
  priceMicros: string;     // BigInt as string: "4990000"
  currency: string;        // ISO 4217: "USD"
  type: 'subscription' | 'product' | 'consumable';
}

export interface NativeTransaction {
  platform: 'apple' | 'google';
  productId: string;
  /** Apple: transactionId. Google: purchaseToken. */
  token: string;
  /** Google only — required for verification. */
  packageName?: string;
  /** Optional pass-through for backend hints. */
  raw?: unknown;
}
```

Adapters live at:
- `src/adapters/native/cdv/native-adapter.ts` — wraps `cordova-plugin-purchase@^13`
- `src/adapters/native/web/web-stub.ts` — no-op for web (purchase calls reject with `PLATFORM_NOT_SUPPORTED`; `getOwnedTransactions` returns `[]`; `acknowledge` is no-op)

Future v6/v7/v8 adapters live alongside `cdv/` and are selected at install time by checking the installed plugin's `package.json#version`.

---

## 5. Public API Surface

The library exports a **factory function** `createIAP<TEntitlement>(config)` that returns an `IAP<TEntitlement>` instance. There is no global singleton; consumers can instantiate as many as they need (typically one per app).

### 5.1 Configuration

```typescript
import { createIAP } from '@nossdev/iap';
import type { EntitlementBase } from '@nossdev/iap';

// Define your entitlement shape (extend the base)
interface AppEntitlement extends EntitlementBase {
  key: string;            // e.g., 'premium', 'remove_ads'
  productId: string;
  expiresAt: string | null;
  // Add app-specific fields the backend returns:
  tier?: 'basic' | 'pro';
  features?: string[];
}

const iap = createIAP<AppEntitlement>({
  // Product catalog (must match what's configured in App Store / Play Console)
  products: [
    {
      id: 'premium_monthly',
      type: 'subscription',
      androidPlanId: 'monthly-plan',  // Required for Android subscriptions
    },
    {
      id: 'premium_yearly',
      type: 'subscription',
      androidPlanId: 'yearly-plan',
    },
    {
      id: 'remove_ads',
      type: 'product',  // One-time non-consumable
    },
    {
      id: 'coin_pack_100',
      type: 'consumable',  // Consumable
    },
  ],

  // Backend integration
  backend: {
    baseUrl: 'https://api.myapp.com',
    endpoints: {
      verifyApple: '/api/iap/verify/apple',     // POST — validate an Apple transaction
      verifyGoogle: '/api/iap/verify/google',   // POST — validate a Google purchase
      entitlements: '/api/iap/entitlements',    // GET  — fetch current entitlements
      restore: '/api/iap/restore',              // POST — restore purchases (re-verify all)
    },
    // Called before every backend request to get auth headers
    getAuthHeaders: async () => ({
      Authorization: `Bearer ${currentUser.token}`,
    }),
    // Optional: customize request/response if your backend uses a different shape
    requestTransform: (request) => request,
    responseTransform: (response) => response,
    timeoutMs: 10000,
    retries: 2,  // For 5xx and network errors only
  },

  // Local persistence (defaults to Capacitor Preferences)
  storage: {
    type: 'preferences',  // | 'memory' | 'custom'
    namespace: 'nossdev_iap',  // Preferences key prefix
    // For 'custom':
    // adapter: { get, set, delete, clear },
  },

  // Behavior
  options: {
    // Auto-call refresh() on app resume (recommended)
    refreshOnResume: true,
    // How often local entitlement cache is considered fresh (ms)
    entitlementCacheTtlMs: 60 * 60 * 1000,  // 1 hour
    // Whether to attempt to recover unfinished transactions on initialize()
    recoverUnfinishedTransactions: true,
    // Logging
    logLevel: 'info',  // 'silent' | 'error' | 'warn' | 'info' | 'debug'
    logger: console,  // Or custom logger interface
  },
});

iap.getEntitlements();        // → AppEntitlement[]
iap.hasEntitlement('premium');  // boolean
```

The default `EntitlementBase` shape — used if no type parameter is supplied — is `{ key: string; productId: string; expiresAt: string | null }`. The library validates the **base** shape via zod against the backend response; consumer-defined fields pass through unvalidated. If the consumer wants strict end-to-end validation they can pass their own zod schema via `config.backend.entitlementSchema`.

The config is validated at runtime with zod; invalid config throws during `createIAP()`.

### 5.2 Lifecycle

```typescript
// Call once at app startup, after auth is ready
await iap.initialize();

// Refresh entitlements from backend (called automatically on resume if configured)
await iap.refresh();

// Tear down (optional — call on logout or unmount)
await iap.destroy();
```

`initialize()` does the following:
1. Validate that `cordova-plugin-purchase` is available (skip on web)
2. Load cached entitlements from Preferences
3. Recover unfinished transactions (if enabled)
4. Emit `ready` event

### 5.3 Product listing

```typescript
// Get all configured products with current pricing/title from native store
const products = await iap.getProducts();
// → [{ id, type, title, description, priceString, priceMicros, currency, ... }]

// Get a specific product
const monthly = await iap.getProduct('premium_monthly');
```

These methods call into `nativeAdapter.getProducts()` and merge the native data with the configured product metadata. **Important:** App Store requires displaying product titles and prices from the native plugin — never hardcode them. Pricing is cached locally for 24 h with a `PRICE_STALE` warning event when stale data is rendered.

### 5.4 Purchase flow

```typescript
// Subscription
const result = await iap.purchase('premium_monthly');

// One-time product
const result = await iap.purchase('remove_ads');

// Discriminated union result
if (result.status === 'success') {
  // Backend validated. Entitlements are already updated.
  // result.transaction has the verified payload from backend.
  console.log('Purchased!', result.transaction);
} else if (result.status === 'cancelled') {
  // User cancelled the native purchase sheet
} else if (result.status === 'pending') {
  // Android: payment is pending (e.g., bank verification)
  // Backend will receive a webhook when it clears
} else if (result.status === 'verification_failed') {
  // Native purchase succeeded, but backend rejected the transaction.
  // Both platforms: NOT acknowledged.
  //   Android — Google auto-refunds in 3 days.
  //   iOS — transaction stays in StoreKit queue, replayed via transactionUpdated listener.
  // Library will retry verification on next refresh().
} else if (result.status === 'failed') {
  // Native error (network, store error, etc.)
  console.error(result.error);
}
```

**Internal sequence (Capacitor 5 / cordova-plugin-purchase):**

1. Acquire the per-product lock; if already held, reject with `ALREADY_IN_PROGRESS`.
2. Emit `purchase-started`.
3. Call `nativeAdapter.purchaseProduct({ productId, productType, ... })`. Internally the adapter:
   - Looks up the cdv `Product` via `store.get(productId)` and the offer via `product.getOffer()`.
   - Attaches a `.approved()` listener for that productId.
   - Calls `offer.order(additionalData?)`. If it returns `IError` with `PAYMENT_CANCELLED` → reject `USER_CANCELLED`; other errors → reject `STORE_ERROR`.
   - When `.approved(tx)` fires, the cdv `Transaction` is captured into `pendingFinish: Map<token, Transaction>` and the promise resolves with the normalized `NativeTransaction`. **`tx.finish()` is NOT called yet.**
4. Write the normalized transaction to `unfinished_transactions` storage **before** calling backend verify.
5. POST to consumer backend `/api/iap/verify/apple` or `/api/iap/verify/google` (per platform) with the token.
6. **If backend returns `{ valid: true, ... }`:**
   - Call `nativeAdapter.acknowledge(transaction)` — looks up the cdv transaction in `pendingFinish` and calls `tx.finish()`.
   - Update local entitlement cache from the backend response.
   - Remove from `unfinished_transactions`.
   - Emit `purchase-success` then `entitlements-changed`.
   - Release the lock.
7. **If backend returns `{ valid: false }` or errors transiently:**
   - **Do NOT call `acknowledge()`** — the cdv transaction stays in `pendingFinish`, unfinished. On Android, Google auto-refunds after 3 days. On iOS, the transaction stays in the StoreKit queue and `.approved()` re-fires on next launch (the adapter's long-lived listener captures it back into `pendingFinish`).
   - Keep entry in `unfinished_transactions` for retry on next `refresh()` / `initialize()`.
   - Emit `verification-failed`.
   - Release the lock.

### 5.5 Restore purchases

```typescript
const result = await iap.restorePurchases();
// → { restored: number, entitlements: Entitlement[] }
```

Used when a user reinstalls the app or switches devices. Internal sequence:
1. Emit `restore-started`
2. Call `nativeAdapter.getOwnedTransactions()` (delegates to `store.restorePurchases()` + `store.localTransactions` filter on cdv)
3. Collect all owned transactions
4. POST batch to backend `/api/iap/restore`
5. Backend re-verifies each via Attesto and returns the consolidated entitlements
6. Update local cache
7. Emit `restore-completed`, then `entitlements-changed`

### 5.6 Entitlement queries

The library does **not** define what an "entitlement" means — that's the backend's job. The library just stores whatever the backend returns and provides cheap accessors.

```typescript
// Synchronous reads from local cache
const isPremium = iap.hasEntitlement('premium');
const allEntitlements = iap.getEntitlements();
// → [{ key: 'premium', expiresAt: '2026-05-10T...', productId: 'premium_monthly' }, ...]

// Get a specific entitlement
const premium = iap.getEntitlement('premium');
// → { key, expiresAt, productId, ... } | null

// Force a fresh fetch from backend
await iap.refresh();
```

The shape of `Entitlement` is generic over `TEntitlement` (passed as type parameter to `createIAP<TEntitlement>`). The library validates only the `EntitlementBase` shape (`{ key, productId, expiresAt }`); consumer-defined fields pass through.

### 5.7 Events

The library emits events on a typed event emitter:

```typescript
iap.on('ready', () => {});
iap.on('purchase-started', ({ productId }) => {});
iap.on('purchase-success', ({ productId, transaction }) => {});
iap.on('purchase-cancelled', ({ productId }) => {});
iap.on('purchase-pending', ({ productId, transaction }) => {});
iap.on('purchase-failed', ({ productId, error }) => {});
iap.on('verification-failed', ({ productId, error }) => {});
iap.on('restore-started', () => {});
iap.on('restore-completed', ({ restored, entitlements }) => {});
iap.on('entitlements-changed', ({ entitlements, previous }) => {});
iap.on('price-stale', ({ productId, lastFetchedAt }) => {});
iap.on('error', ({ error }) => {});  // Library-level errors

// Unsubscribe
const unsub = iap.on('entitlements-changed', handler);
unsub();
```

This makes it easy for Vue/React/Svelte stores to subscribe and react.

### 5.8 Backend contract (Attesto-aligned)

The library has a **default contract** with the consumer's backend that mirrors Attesto's split-by-platform shape. This minimizes translation in the consumer backend (it's mostly a pass-through to Attesto plus an entitlement-mapping step).

Consumers can override request/response shapes via `config.backend.requestTransform` / `responseTransform` if they already have a different convention.

#### `POST /api/iap/verify/apple`

Request:
```json
{
  "productId": "premium_monthly",
  "transactionId": "2000000123456789",
  "type": "subscription"
}
```

Recommended consumer-backend implementation: forward `{ transactionId }` to `POST /v1/apple/verify` on Attesto, then map Attesto's `NormalizedAppleTransaction` to the consumer's entitlements.

Response (200, valid):
```json
{
  "valid": true,
  "entitlements": [
    { "key": "premium", "productId": "premium_monthly", "expiresAt": "2026-05-10T14:22:10.000Z" }
  ],
  "transaction": {
    "id": "2000000123456789",
    "productId": "premium_monthly",
    "expiresAt": "2026-05-10T14:22:10.000Z",
    "verifiedAt": "2026-04-28T10:00:00.000Z",
    "ownership": "PURCHASED"
  }
}
```

Response (200, invalid):
```json
{
  "valid": false,
  "error": "TRANSACTION_NOT_FOUND",
  "message": "Apple returned TRANSACTION_NOT_FOUND"
}
```

#### `POST /api/iap/verify/google`

Request:
```json
{
  "productId": "premium_monthly",
  "purchaseToken": "...",
  "packageName": "com.example.app",
  "type": "subscription"
}
```

Response shape: identical to Apple (same `valid` / `entitlements` / `transaction` envelope), with platform-specific fields surfaced inside `transaction.raw` if the consumer wants them.

#### `GET /api/iap/entitlements`

Response (200):
```json
{
  "entitlements": [
    { "key": "premium", "productId": "premium_monthly", "expiresAt": "2026-05-10T14:22:10.000Z" }
  ]
}
```

#### `POST /api/iap/restore`

Request:
```json
{
  "transactions": [
    { "platform": "apple", "transactionId": "2000000...", "productId": "premium_monthly" },
    { "platform": "google", "purchaseToken": "...", "packageName": "com.example.app", "productId": "premium_monthly" }
  ]
}
```

Response: same envelope as `/verify/apple` but with consolidated entitlements.

#### Auth + tenanting

The library doesn't know about Attesto's tenant model — that's the consumer backend's concern. The library only calls `config.backend.getAuthHeaders()` before each request. The consumer backend uses those headers to identify the user and its own Attesto tenant.

#### Error mapping

| HTTP status | Library treatment |
|---|---|
| 200 + `valid: true` | Success |
| 200 + `valid: false` | `VERIFICATION_REJECTED`; do not retry |
| 401 / 403 | `BACKEND_AUTH_FAILED`; do not retry; emit `error` |
| 408 / 429 / 5xx | `BACKEND_UNAVAILABLE` or `BACKEND_TIMEOUT`; retry with backoff (3 attempts) |
| network error | `BACKEND_UNAVAILABLE`; retry with backoff |

---

## 6. Project Structure

```
iap/
├── README.md                      # Overview, quickstart, link to docs
├── LICENSE                        # MIT
├── CONTRIBUTING.md
├── CHANGELOG.md
├── package.json                   # Dual ESM/CJS, strict peer deps, public access
├── tsconfig.json
├── tsup.config.ts                 # Build config
├── vitest.config.ts
├── biome.json
├── .gitignore
├── .github/
│   └── workflows/
│       ├── ci.yml                 # Lint + test on PR
│       └── publish.yml            # Publish to npm + GitHub Packages on tag
├── src/
│   ├── index.ts                   # Public exports
│   ├── createIAP.ts               # Factory + main IAP class
│   │
│   ├── types/
│   │   ├── config.ts              # Config schema (zod) + types
│   │   ├── product.ts             # Product, Transaction types
│   │   ├── entitlement.ts         # EntitlementBase, DefaultEntitlement
│   │   ├── transaction.ts         # NativeTransaction, VerifiedTransaction
│   │   ├── events.ts              # Event payloads
│   │   └── results.ts             # PurchaseResult, RestoreResult
│   │
│   ├── core/
│   │   ├── purchase-flow.ts       # The orchestration logic for purchases
│   │   ├── restore-flow.ts        # Restore orchestration
│   │   ├── refresh-flow.ts        # Entitlement refresh
│   │   └── unfinished-recovery.ts # Recover pending transactions on init
│   │
│   ├── adapters/
│   │   ├── native/
│   │   │   ├── index.ts           # Selects active adapter via Capacitor.getPlatform()
│   │   │   ├── types.ts           # NativeAdapter interface
│   │   │   ├── cdv/
│   │   │   │   └── native-adapter.ts  # Wraps cordova-plugin-purchase@^13
│   │   │   └── web/
│   │   │       └── web-stub.ts    # No-op for web platform
│   │   ├── backend/
│   │   │   ├── http-client.ts     # Fetch wrapper with retries + timeout
│   │   │   ├── verify.ts          # POST /verify/{apple,google}
│   │   │   ├── entitlements.ts    # GET /entitlements
│   │   │   └── restore.ts         # POST /restore
│   │   └── storage/
│   │       ├── index.ts
│   │       ├── preferences-adapter.ts
│   │       ├── memory-adapter.ts
│   │       └── types.ts
│   │
│   ├── events/
│   │   └── emitter.ts             # Typed event emitter
│   │
│   ├── lib/
│   │   ├── platform.ts            # Capacitor.getPlatform() wrapper
│   │   ├── logger.ts              # Logger interface + default impl
│   │   └── errors.ts              # IAPError + error codes
│   │
│   └── version.ts                 # Build-injected library version
│
├── tests/
│   ├── unit/
│   │   ├── purchase-flow.test.ts
│   │   ├── restore-flow.test.ts
│   │   ├── http-client.test.ts
│   │   ├── preferences-adapter.test.ts
│   │   ├── native-adapter.test.ts
│   │   └── emitter.test.ts
│   ├── integration/
│   │   └── full-flow.test.ts      # End-to-end with mocked native + backend
│   ├── mocks/
│   │   ├── mock-cdv-purchase.ts   # Fake cordova-plugin-purchase / CdvPurchase
│   │   ├── mock-backend.ts        # Fake fetch / backend
│   │   └── mock-preferences.ts    # In-memory Preferences
│   └── fixtures/
│       ├── apple-transaction.json
│       └── google-purchase.json
│
└── docs/
    ├── getting-started.md         # Install + first purchase in 5 min
    ├── backend-contract.md        # What your backend must implement
    ├── product-configuration.md   # How to set up products in stores
    ├── testing.md                 # Sandbox testing on iOS + Android
    ├── framework-recipes/
    │   ├── vue-quasar.md          # Reactive store pattern
    │   ├── react.md               # Hook pattern
    │   ├── pinia-store.md         # Specific Pinia recipe
    │   └── optimistic-grant.md    # Pattern for optimistic UI grant
    ├── internal/
    │   └── plugin-v5-api.md       # Documented v5 method signatures
    └── migration.md               # Upgrading between Capacitor majors
```

### `package.json` essentials

```json
{
  "name": "@nossdev/iap",
  "version": "0.1.0",
  "description": "Thin Capacitor IAP orchestrator that pairs with Attesto for receipt validation",
  "license": "MIT",
  "author": "nossdev",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
  "keywords": ["capacitor", "iap", "in-app-purchase", "storekit", "billing", "attesto"],
  "repository": {
    "type": "git",
    "url": "https://github.com/nossdev/iap.git"
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check src tests",
    "format": "biome format --write src tests",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run typecheck && npm run lint && npm run test && npm run build"
  },
  "peerDependencies": {
    "@capacitor/core": "^5.0.0",
    "@capacitor/preferences": "^5.0.0",
    "cordova-plugin-purchase": "^13.0.0"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@capacitor/core": "^5.0.0",
    "@capacitor/preferences": "^5.0.0",
    "cordova-plugin-purchase": "^13.15.4",
    "jsdom": "^25.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@vitest/coverage-v8": "^1.6.0",
    "@biomejs/biome": "^1.7.0"
  }
}
```

The peer dep range targets Capacitor 5 only for v0.1.0. **Dev deps pin to `cordova-plugin-purchase@^13.15.4`** (latest stable; the maintainer ships frequent patches). Vitest uses **jsdom** because cordova-plugin-purchase attaches to `window.CdvPurchase` at module load.

---

## 7. State Management — Entitlements

### Local cache structure (Capacitor Preferences)

```
nossdev_iap.entitlements          → JSON: { entitlements: [...], cachedAt: timestamp }
nossdev_iap.unfinished_transactions → JSON: [{ productId, transactionId, ... }, ...]
nossdev_iap.last_refresh           → timestamp
nossdev_iap.product_prices         → JSON: { products: [...], cachedAt: timestamp }
```

### Cache TTL semantics

- The cache is **always read on initialize()** for instant entitlement checks at app startup
- The cache is **refreshed in the background** if `refreshOnResume` is enabled
- If `entitlementCacheTtlMs` is exceeded, `hasEntitlement()` still returns the cached value but the library schedules a refresh
- The cache is **explicitly refreshed** after every purchase / restore based on backend response

### 7.1 Reactive pattern for consumer apps

The library emits `entitlements-changed` whenever the cache changes. Consumer apps wire this into their state management:

**Vue / Pinia:**
```typescript
// stores/iap.ts
export const useIapStore = defineStore('iap', () => {
  const entitlements = ref<Entitlement[]>([]);
  const isPremium = computed(() => entitlements.value.some(e => e.key === 'premium'));

  iap.on('entitlements-changed', ({ entitlements: e }) => {
    entitlements.value = e;
  });

  return { entitlements, isPremium };
});
```

**React:**
```typescript
function useEntitlements() {
  const [entitlements, setEntitlements] = useState(iap.getEntitlements());
  useEffect(() => iap.on('entitlements-changed', ({ entitlements }) => {
    setEntitlements(entitlements);
  }), []);
  return entitlements;
}
```

These patterns will be documented in `docs/framework-recipes/`.

### 7.4 Real-time entitlement updates via server-side webhooks

Attesto receives App Store Server Notifications V2 and Google RTDN, dedupes them, and forwards verified events to the consumer's registered webhook URL. When the consumer backend processes one of these events (e.g., subscription renewal, refund, billing retry), it should:

1. Update its own entitlement state.
2. Notify connected clients via push notification, WebSocket, or polling.

The client's job: when it receives such a notification, call `await iap.refresh()`. The library will fetch fresh entitlements from `/api/iap/entitlements` and emit `entitlements-changed`.

```typescript
// Example: integrate with Capacitor PushNotifications
import { PushNotifications } from '@capacitor/push-notifications';

PushNotifications.addListener('pushNotificationReceived', async (notification) => {
  if (notification.data?.type === 'iap_entitlements_updated') {
    await iap.refresh();
  }
});
```

The library does not subscribe to push notifications itself — that's the consumer's domain. Calling `refresh()` from the consumer's notification handler is the recommended pattern.

---

## 8. Error Handling

### Error class hierarchy

```typescript
class IAPError extends Error {
  code: IAPErrorCode;
  cause?: unknown;
  recoverable: boolean;
}

enum IAPErrorCode {
  // Configuration
  INVALID_CONFIG = 'INVALID_CONFIG',
  NOT_INITIALIZED = 'NOT_INITIALIZED',

  // Native plugin
  PLATFORM_NOT_SUPPORTED = 'PLATFORM_NOT_SUPPORTED',
  BILLING_NOT_AVAILABLE = 'BILLING_NOT_AVAILABLE',
  PRODUCT_NOT_FOUND = 'PRODUCT_NOT_FOUND',
  USER_CANCELLED = 'USER_CANCELLED',
  PURCHASE_PENDING = 'PURCHASE_PENDING',
  ALREADY_PURCHASED = 'ALREADY_PURCHASED',
  STORE_ERROR = 'STORE_ERROR',
  UNACKNOWLEDGED_PENDING = 'UNACKNOWLEDGED_PENDING',  // Google purchase unacknowledged >2d

  // Concurrency
  ALREADY_IN_PROGRESS = 'ALREADY_IN_PROGRESS',  // Another purchase of the same product is in flight

  // Backend
  BACKEND_UNAVAILABLE = 'BACKEND_UNAVAILABLE',
  BACKEND_TIMEOUT = 'BACKEND_TIMEOUT',
  BACKEND_AUTH_FAILED = 'BACKEND_AUTH_FAILED',
  VERIFICATION_REJECTED = 'VERIFICATION_REJECTED',  // valid: false from backend

  // Storage
  STORAGE_ERROR = 'STORAGE_ERROR',
}
```

### Failure modes and recovery

| Scenario | What happens | Recovery |
|---|---|---|
| User cancels native sheet | Returns `{ status: 'cancelled' }`. No state change. | None needed. |
| Network down during verify | Native purchase succeeded but backend unreachable. Transaction NOT acknowledged on either platform; persisted to unfinished list. | Auto-retry on next `refresh()` or `initialize()`. |
| Backend returns `valid: false` | NOT acknowledged on either platform. Android: Google auto-refunds in 3 days. iOS: transaction replayed via `transactionUpdated` listener on next launch. Emit `verification-failed`; persisted. | Manual user action or auto-retry; if backend keeps rejecting, surface error to user. |
| Backend 5xx | Treated as transient. NOT acknowledged. Persisted. | Library retries with backoff (3 attempts, 1s/2s/4s); if all fail, persisted for next session. |
| Backend 4xx (auth) | Treated as fatal config error. Emit `error`. | Consumer must fix auth and retry manually. |
| App killed mid-purchase | Native plugin's transaction queue still has the unacknowledged transaction (both platforms). | On next `initialize()`, `recoverUnfinishedTransactions` re-fetches via `getOwnedTransactions()` and re-verifies. iOS additionally fires `transactionUpdated`. |
| Pending Android purchase | Returns `{ status: 'pending' }`. Backend should receive Google webhook when cleared. | Library doesn't poll — relies on `refresh()` or webhook-driven backend update. |

### The "unfinished transaction" pattern

This is the **most important reliability mechanism** in the library:

1. After `nativeAdapter.purchaseProduct()` succeeds, the library writes the transaction to `nossdev_iap.unfinished_transactions` *before* calling backend verify
2. If verify succeeds, library calls `nativeAdapter.acknowledge()` and removes from unfinished list
3. If verify fails or app dies, transaction stays in unfinished list AND in native plugin's transaction queue (Android)
4. On next `initialize()`, library reads unfinished list and re-attempts verification
5. After successful verification on retry, acknowledge the transaction

This guarantees **at-least-once delivery to backend** and **never acknowledges a transaction without backend confirmation** on both platforms (because v7's `autoAcknowledgePurchases: false` defers finishing on iOS too).

---

## 9. Web Platform Behavior

`@capgo/native-purchases` is iOS/Android only, but `@capacitor/preferences` works on web (backed by `localStorage`). On web:

- Platform detection: `Capacitor.getPlatform() === 'web'`
- Native adapter: `web-stub.ts` — `purchase()` and `restorePurchases()` reject with `PLATFORM_NOT_SUPPORTED`; `getOwnedTransactions()` returns `[]`; `acknowledge()` is a no-op
- Storage: real Preferences (localStorage) — entitlement cache works fully, so synchronous entitlement reads like `iap.hasEntitlement('premium')` return correct values from a previous mobile session if the same user account is logged in (the cache is keyed per-user via the consumer's auth)
- `refresh()` works on web — it's a plain HTTP call to the consumer backend, independent of the native plugin
- `initialize()` succeeds on web; it logs a single info-level note ("Native purchases unavailable on web; entitlement queries still functional")

This lets developers run their app via `npm run dev` or in a browser test environment without crashes, and entitlement-gated UI renders correctly based on cached state.

---

## 10. Testing Strategy

### Unit tests
- **Purchase flow:** mock native + backend, verify orchestration sequence, verify `acknowledge()` is called only after backend success on Android
- **Restore flow:** mock native returning multiple transactions, verify batched send to backend
- **Refresh flow:** mock backend, verify cache update and event emission
- **HTTP client:** verify timeout, retry on 5xx/network, no retry on 4xx
- **Storage adapters:** Preferences adapter against an in-memory mock; verify serialize/deserialize roundtrip
- **Event emitter:** subscription, unsubscribe, multiple listeners, event payload typing
- **Native adapter (web stub):** all purchase methods reject with PLATFORM_NOT_SUPPORTED
- **Native adapter (v5):** mocked plugin calls; verify parameter mapping and acknowledge behavior

### Integration tests
- **Full purchase flow:** mock `cordova-plugin-purchase` (`CdvPurchase` global) via `tests/mocks/mock-cdv-purchase.ts`; mock backend with a fake fetch; assert end-to-end behavior including event sequence
- **Failure recovery:** simulate backend failure, assert transaction lands in unfinished list; on next `initialize()`, simulate backend recovery and assert verification completes
- **Concurrent purchase attempts:** ensure library prevents two purchases of the same product simultaneously (lock per productId; second rejects with `ALREADY_IN_PROGRESS`)

### Manual end-to-end tests
- **Real Apple sandbox:** use a sandbox tester account, complete a purchase, observe full flow against a staging Attesto + backend
- **Real Google test track:** use license testers, complete a purchase, observe full flow
- **Restore flow:** purchase, uninstall, reinstall, restore, verify entitlement comes back
- **Pending purchase (Android):** use a slow test card to trigger a pending state
- **Refund flow:** issue a refund in App Store Connect, verify webhook → backend → next `refresh()` reflects revocation

### Coverage target
- Unit + integration: **>90% line coverage**
- All public API methods covered by at least one test
- Every error code thrown by at least one test

---

## 11. Build & Publish

### Build pipeline

```
src/*.ts
    │
    ▼
tsup
    │
    ├─→ dist/index.js      (ESM)
    ├─→ dist/index.cjs     (CJS)
    └─→ dist/index.d.ts    (Types)
```

Configured for:
- `target: 'es2022'` (Capacitor 5+ supports modern JS)
- `format: ['esm', 'cjs']`
- `dts: true`
- `sourcemap: true`
- `clean: true`

### Versioning strategy

Semver, with the following meaning:

- **Major bump** when the public API changes (rare — try hard not to)
- **Minor bump** when adding features
- **Patch bump** for bug fixes

The library version is **independent** of Capacitor version. A support matrix in the README documents which `@nossdev/iap` versions work with which Capacitor versions.

Initial release: `0.1.0`. Stay below 1.0 until the API has been validated against at least 3 production apps.

### Publishing

- Primary registry: **public npm** as `@nossdev/iap` (configured via `"publishConfig": { "access": "public" }` in `package.json` — required because npm scoped packages default to private)
- Mirror: **GitHub Packages** under `nossdev` org (driven by the same CI workflow on tag push)
- CI publishes on git tag `v*.*.*` via GitHub Actions (`.github/workflows/publish.yml`)
- README on npm includes Capacitor support matrix prominently

### Capacitor support matrix (initial)

| `@nossdev/iap` | Capacitor | Plugin | Status |
|---|---|---|---|
| 0.x | 5.x | `cordova-plugin-purchase ^13.x` | **v0.1.0 target** — supports Infopathy production. |
| 1.x | 7.x | `@capgo/native-purchases 7.16.2` | Future — adds Cap 7 adapter (preserved in commit `f1d20ed`). |
| 2.x | 8.x | `@capgo/native-purchases ^8.x` | Future. |
| 3.x | 5–8 | mixed | Future — single binary supports all majors via runtime adapter selection. |

When supporting newer Capacitor versions, the goal is to **preserve the public API** so consumers only need to bump peer deps.

---

## 12. Implementation Phases

Ship in thin slices. Each phase shippable on its own.

### Phase 1 — Skeleton & native adapter (est. 1.5 days)

#### 1a. Repo bootstrap (90 min)

- [ ] `cd /home/yev/Projects/opensource/iap && git init`
- [ ] `gh repo create nossdev/iap --public --description "Thin Capacitor IAP orchestrator that pairs with Attesto"` (or skip `--public` and make it public after initial scaffold)
- [ ] Create `LICENSE` (MIT, copyright "nossdev")
- [ ] Create `.gitignore` (Node template + `dist/`, `coverage/`, `.env`)
- [ ] Create `README.md` skeleton (title + one-paragraph description + "Status: pre-alpha; do not use in production")
- [ ] Create `CHANGELOG.md` with `## [Unreleased]` heading
- [ ] `npm init -y` then edit `package.json` per §6 (name, license, peerDeps, scripts, exports, publishConfig)
- [ ] `npm install --save-exact zod@^3.23.0`
- [ ] `npm install --save-dev typescript@^5.4 tsup@^8 vitest@^1.6 @biomejs/biome@^1.7 @capacitor/core@^5 @capacitor/preferences@^5 cordova-plugin-purchase@^13 @vitest/coverage-v8@^1.6.0 jsdom@^25`
- [ ] Create `tsconfig.json` (`target: "es2022"`, `module: "esnext"`, `moduleResolution: "bundler"`, `strict: true`, `declaration: true`, `outDir: "dist"`)
- [ ] Create `tsup.config.ts` (`entry: ['src/index.ts']`, `format: ['esm', 'cjs']`, `dts: true`, `sourcemap: true`, `clean: true`, `target: 'es2022'`)
- [ ] Create `vitest.config.ts` (`globals: true`, `environment: 'jsdom'` — cordova-plugin-purchase attaches to `window`)
- [ ] Create `biome.json` (extends recommended, line width 100)
- [ ] First commit: `chore: scaffold project (TypeScript, tsup, vitest, biome)`

#### 1b. cordova-plugin-purchase reconnaissance (60 min) — **completed 2026-04-28**

- [x] Read `node_modules/cordova-plugin-purchase/www/store.d.ts` and document **actual** plugin method signatures in `docs/internal/cdv-purchase-api.md`
- [x] Confirmed: `Store.register()`, `Store.initialize()`, `Store.update()`, `Store.order(offer)`, `Store.restorePurchases()`, `store.when().approved()`, `tx.finish()` — all present
- [x] Confirmed deferred finish via manual `tx.finish()` works on both iOS and Android — §2.1 guarantee is full
- [x] Commit: `docs: document cordova-plugin-purchase 13.x API surface`

#### 1c. Type definitions (90 min)

- [ ] Create `src/types/config.ts` with zod schema and inferred type for `IAPConfig`
- [ ] Create `src/types/product.ts` with `Product`, `NativeProduct`
- [ ] Create `src/types/entitlement.ts` with `EntitlementBase` and `DefaultEntitlement`
- [ ] Create `src/types/transaction.ts` with `NativeTransaction`, `VerifiedTransaction`
- [ ] Create `src/types/events.ts` with the typed `EventMap`
- [ ] Create `src/types/results.ts` with `PurchaseResult`, `RestoreResult` discriminated unions
- [ ] Create `src/lib/errors.ts` with `IAPError` class and `IAPErrorCode` enum
- [ ] Commit: `feat: define core types`

#### 1d. Native adapter (90 min)

- [ ] Create `src/adapters/native/types.ts` with `NativeAdapter` interface (per §4.1)
- [ ] Create `src/adapters/native/cdv/native-adapter.ts` wrapping `cordova-plugin-purchase@^13` per the doc from 1b
- [ ] Create `src/adapters/native/web/web-stub.ts`
- [ ] Create `src/adapters/native/index.ts` selecting the right adapter via `Capacitor.getPlatform()`
- [ ] Create `src/lib/platform.ts` (`getPlatform`, `isNative`)
- [ ] Add tests in `tests/unit/native-adapter.test.ts` for the web stub (rejects with PLATFORM_NOT_SUPPORTED) and a mocked cdv adapter happy path
- [ ] Commit: `feat: native adapter v5 + web stub`

#### 1e. Factory + initialize (60 min)

- [ ] Create `src/createIAP.ts` exporting `createIAP<TEntitlement>(config)` returning an `IAP<TEntitlement>` instance
- [ ] Implement `initialize()`: validate config via zod, instantiate adapter, load cached entitlements (no-op until Phase 2), emit `ready`
- [ ] Create `src/events/emitter.ts` with a typed event emitter
- [ ] Create `src/lib/logger.ts` with the `Logger` interface and a default console-backed impl
- [ ] Create `src/index.ts` with public exports (`createIAP`, types, `IAPError`, `IAPErrorCode`)
- [ ] Add tests for config validation (good config / bad config)
- [ ] Commit: `feat: createIAP factory + initialize lifecycle`

#### 1f. CI green (45 min)

- [ ] Create `.github/workflows/ci.yml` running `npm run typecheck && npm run lint && npm test && npm run build` on PR + push to `main`
- [ ] Push to `nossdev/iap`, verify CI green
- [ ] Commit: `ci: lint + typecheck + test + build pipeline`

**Exit criterion (Phase 1):** `createIAP({ ... })` works on iOS, Android, and web. Web gracefully no-ops purchase calls; iOS/Android hit the cdv adapter. CI is green on `main`. README has a "Status" badge linking to CI.

### Phase 2 — Storage + entitlement cache (est. 0.5 day)
- [ ] Implement `PreferencesAdapter` (real Capacitor Preferences)
- [ ] Implement `MemoryAdapter` (for tests + web dev)
- [ ] Implement entitlement cache: read on init, write on update
- [ ] Implement `hasEntitlement()`, `getEntitlements()`, `getEntitlement()` reads
- [ ] Tests: cache roundtrip, TTL behavior, namespace isolation

**Exit:** Cached entitlements survive app restarts. Sync reads work without network.

### Phase 3 — Backend HTTP client (est. 1 day)
- [ ] Implement fetch wrapper with timeout, retry on 5xx, no retry on 4xx
- [ ] Implement `verify` (per-platform), `entitlements`, `restore` calls
- [ ] Wire `getAuthHeaders` callback
- [ ] Implement request/response transforms
- [ ] Tests: timeout, retry behavior, error mapping to `IAPError`, transforms

**Exit:** Library can talk to a mocked backend cleanly with proper error semantics.

### Phase 4 — Purchase flow (est. 2 days)
- [ ] Implement `purchase()` orchestration
- [ ] Wire native call → backend verify → `nativeAdapter.acknowledge`
- [ ] Implement unfinished transaction persistence
- [ ] Wire event emission throughout the flow
- [ ] Handle `cancelled`, `pending`, `verification_failed`, `failed` paths
- [ ] Lock: prevent concurrent purchases of the same product
- [ ] Tests: full flow with all 5 result statuses; verify `acknowledge()` is NOT called on Android failure; verify cache stays unchanged on iOS failure

**Exit:** Calling `purchase()` against mocks produces correct event sequence and final cache state for all paths.

### Phase 5 — Restore flow (est. 1 day)
- [ ] Implement `restorePurchases()` orchestration
- [ ] Call `nativeAdapter.getOwnedTransactions()` and batch to backend
- [ ] Update entitlement cache from response
- [ ] Tests: empty restore, single restore, multi-product restore

**Exit:** Restoring on a fresh install correctly re-grants entitlements.

### Phase 6 — Refresh + recovery (est. 1 day)
- [ ] Implement `refresh()` against `/entitlements`
- [ ] Implement `recoverUnfinishedTransactions()` on initialize
- [ ] Wire `App.addListener('appStateChange')` for `refreshOnResume`
- [ ] Tests: recovery after simulated app crash mid-purchase

**Exit:** App resume triggers entitlement refresh. Killed-mid-purchase transactions complete on next launch.

### Phase 7 — Polish + docs (est. 1.5 days)
- [ ] Logger interface with levels + default impl
- [ ] Comprehensive error messages with remediation hints
- [ ] README with quickstart + support matrix + Known Limitations (plugin v7 line frozen)
- [ ] Backend contract doc
- [ ] Vue/Quasar recipe (Yev's primary stack)
- [ ] React + Pinia recipes
- [ ] Optimistic-grant pattern recipe
- [ ] Testing guide for consumers (sandbox setup)
- [ ] Migration doc placeholder

**Exit:** A consumer with no prior context can install, configure, and complete their first purchase in <30 minutes following the README.

### Phase 8 — Publish + field testing (ongoing)

**Pivot (2026-04-29):** previously this phase gated `0.1.0` on a successful first production purchase. That bar was over-cautious for a 0.x library — patch releases are cheap to ship, and 0.x is itself the "expect breaking changes" signal. New approach: publish `0.1.0` once everything works (CI green + sandbox round-trip clean) and ship fixes via patch releases as production usage surfaces issues.

- [x] Configure release workflow (`.github/workflows/release.yml`, `NPM_TOKEN` secret, `--provenance`)
- [ ] Tag `v0.1.0` and publish to npm (workflow handles publish)
- [ ] Migrate Infopathy from any pre-existing IAP code to `@nossdev/iap@^0.1.0`
- [ ] Test against real Apple sandbox + Google test track; ship fixes as `0.1.x` patches
- [ ] Iterate on API based on production feedback
- [ ] Bump to `1.0.0` after API stabilizes across 2+ production apps (no breaking changes for 4 consecutive patches)
- [ ] Migrate `NPM_TOKEN` → npm OIDC trusted publishers (follow-up after first publish exists)

**Exit:** Library is on npm. CHANGELOG tracks `0.1.x` patch releases as production feedback comes in. API has stabilized across multiple production apps before any `1.0.0` bump.

---

## 13. Known Edge Cases & Gotchas

### Capacitor 5 / `cordova-plugin-purchase` ^13

- **The plugin is a Cordova plugin loaded via Capacitor's Cordova bridge.** Consumers must run `npx cap sync` after installing it for the native iOS/Android projects to pick up the plugin code. Document this in the setup guide (Phase 7).
- **`CdvPurchase` is exposed as a global namespace** (the plugin attaches to `window.CdvPurchase` at module load). The adapter accesses it via `globalThis.CdvPurchase` after a side-effect import. Vitest needs `environment: 'jsdom'` (not `'node'`) for tests to load the plugin without errors.
- **The plugin's API is event-driven, not Promise-based.** The adapter wraps `.approved()`, `.failed()`, etc. into Promises; consumers of `@nossdev/iap` see the same Promise-based public API.

### cordova-plugin-purchase specifics

- **No `.cancelled()` callback on `When`** — cancellation surfaces through `IError` returned by `Store.order(offer)` with `code === ErrorCode.PAYMENT_CANCELLED`. The adapter maps this to `IAPError(USER_CANCELLED)`.
- **Google Play 3-day window:** unacknowledged Android purchases auto-refund after 3 days. The library calls `tx.finish()` immediately on backend success; if the backend is down for >3 days, Google auto-refunds. This is the correct behavior — the user paid for something they don't have.
- **`tx.finish()` is the single cross-platform finish/ack call** — for Android it acknowledges via Google Play Billing; for iOS it calls StoreKit 2's `Transaction.finish()`. The adapter never calls it before backend verifies.
- **`store.restorePurchases()` re-fires `.approved()`** for owned transactions on subsequent calls. The adapter's long-lived `.approved()` listener captures these into `pendingFinish`; the per-purchase listener has a `settled` flag to avoid double-resolving the original promise.
- **`store.update()` has a min-interval** (`store.minTimeBetweenUpdates`, default 60s). Calling rapidly is a no-op. The adapter calls it once during bootstrap; consumers can call `iap.refresh()` to force entitlement refresh independently.
- **Subscription replacement** is handled via the optional `group` field on registered products. Out of v0.1.0 scope; can be added later with a `groupName` config field.

### iOS-specific

- **Family sharing:** transactions can have `inAppOwnershipType: 'FAMILY_SHARED'`. The library passes this through to the backend; the backend decides what to do.
- **Promotional offers:** the native plugin handles promo code redemption, but Attesto / your backend will need to handle the offer fields. Library doesn't interpret them.
- **App Store Server Notifications V2** changes flow asynchronously through Attesto → your backend. Library only learns about renewals/cancellations via `refresh()` (or push-triggered refresh — see §7.4).
- **StoreKit Testing in Xcode:** local testing uses a different cert chain. Backend (Attesto) needs to be configured with a test fingerprint; library doesn't care.

### Android-specific

- **`planIdentifier` is required for subscriptions.** Configured in product catalog as `androidPlanId`.
- **Acknowledgement:** Google Play requires acknowledging purchases within 3 days or they auto-refund. The library acknowledges on backend success.
- **Pending purchases:** can stay in pending state for hours/days. Library returns `{ status: 'pending' }`; backend will eventually receive a Google RTDN webhook when it clears.
- **`launchMode`:** the consumer's `MainActivity` must use `standard` or `singleTop` launch mode, otherwise the purchase flow can be cancelled when the user backgrounds the app to verify in their banking app. Document this in the setup guide.

### Concurrency

- **Two simultaneous `purchase()` calls** for the same product: library locks per-productId and second call rejects with `ALREADY_IN_PROGRESS`.
- **`refresh()` during a purchase:** allowed; refresh runs independently against `/entitlements`. Purchase flow has its own write path that wins on conflict.
- **App killed during verify HTTP call:** unfinished transaction persisted; recovered on next init.

### Backend contract drift

- **If the backend changes response shape**, library should fail loudly via zod validation. Don't silently accept malformed responses.
- **If the backend requires new fields**, consumer can use `requestTransform` / `responseTransform` until the library API evolves.

### Logging hygiene

- Never log: full transaction JWS, purchase tokens (mask to first 8 chars), auth headers
- Log: productId, status, error code, timing
- Consumer can plug in their own logger (Sentry, Datadog, etc.)

---

## 14. Non-Goals (Explicit)

These will be tempting. Push back — they belong elsewhere.

- ❌ Built-in paywall / product card UI components
- ❌ A/B testing for IAPs
- ❌ Promo code or offer code business logic
- ❌ Direct Attesto API calls from the library
- ❌ Replacing Pinia / Redux / Zustand for state management
- ❌ Analytics tracking (consumer wires this via events)
- ❌ Receipt validation logic
- ❌ Subscription state machine interpretation (grace periods, billing retry)
- ❌ Multiplatform abstractions beyond iOS/Android (no Stripe, no PayPal, no web payments)
- ❌ Subscription management UI (deep-linking to App Store / Play Store settings is fine; building a UI for it is not)

---

## 15. Decisions log

Resolved during planning (2026-04-28):

1. **Capacitor target for v0.1.0:** Capacitor 5 (Infopathy production app — `com.ashnutech.infopathy.app` — is on Cap 5 and IAP integration is the last blocker for App Store / Play Store approval). Cap 7+ deferred to v1.x; the v7 adapter built earlier in this project is preserved in git commit `f1d20ed` for restoration when Infopathy migrates Capacitor.
2. **Plugin choice:** `cordova-plugin-purchase` (`^13.x`). Reason: only free Cap-5-compatible IAP plugin with deferred-finish support. `@capgo/native-purchases@0.0.72` (the only Cap-5-compatible release in that line) lacks `acknowledgePurchase` and `autoAcknowledgePurchases`, so it cannot defer finishing; cordova-plugin-purchase has the canonical async `tx.finish()` pattern.
3. **License:** MIT.
4. **Publish scope:** public npm from v0.1.0; GitHub Packages mirror.
5. **`getCustomerInfo()`-style API:** No. Always go through the consumer backend.
6. **Native pricing/title cache:** 24-hour TTL with `PRICE_STALE` warning event when stale data is rendered.
7. **Optimistic-grant pattern:** No built-in support. Document the pattern in `docs/framework-recipes/optimistic-grant.md` for consumers who want it.

Open and tracked:

8. **First production purchase:** target Infopathy sandbox during Phase 8. Not a publish gate — `0.1.0` ships when CI is green + sandbox round-trip is clean; production validation happens against shipped `0.1.x` releases, with fixes shipped as patch versions.

---

## 16. Quick Reference for Claude Code

### When starting a new session
1. Read this PLAN.md in full
2. Check CHANGELOG.md for completed phases
3. Run `npm test` and `npm run typecheck` to confirm baseline is green
4. Check GitHub Issues for current priorities

### Decisions already made (do not re-litigate)
- **Name:** `@nossdev/iap`
- **Type:** TypeScript library, NOT a Capacitor plugin
- **Native bridge:** `@capgo/native-purchases` (peer dep, version-matched to Capacitor)
- **Initial Capacitor target:** 5 (peer-dep range: `^5.0.0`; pinned plugin: `cordova-plugin-purchase@^13`)
- **Architecture:** library → consumer's backend → Attesto (library NEVER calls Attesto directly)
- **Storage:** Capacitor Preferences (with memory adapter for tests + web)
- **Build:** tsup, dual ESM/CJS, full TypeScript types
- **Test:** vitest, target >90% coverage
- **License:** MIT
- **Distribution:** public npm + GitHub Packages mirror

### Commit style
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`)
- One logical change per commit

### Before opening a PR
- `npm run lint`
- `npm run typecheck`
- `npm test`
- Update CHANGELOG.md under `## [Unreleased]`

### When in doubt
- If unsure whether a feature belongs in the library: it probably doesn't. Push back.
- If a plugin behavior differs across Capacitor majors: handle it in `native-adapter.ts`, not in core flows.
- Never acknowledge a purchase before backend confirms (Android).
- Never log raw tokens, JWS payloads, or auth headers.
- Never assume the backend response shape — validate with zod and fail loudly.
- Web platform is no-op for purchases but should never crash.

---

## 17. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | cordova-plugin-purchase event-driven API leaks edge cases the adapter must paper over (e.g., `.approved()` re-firing during restore, no `.cancelled()` callback) | Medium | Medium | Comprehensive adapter unit tests + Phase 8 sandbox testing on a real device |
| R2 | Plugin behavior diverges between cdv (v0.1) and `@capgo/native-purchases` (v1+) once Cap 7 migration happens | Medium | Medium | Core flows depend only on `NativeAdapter` interface; integration tests use mocked NativeAdapter so they're plugin-agnostic |
| R3 | Consumer backend response shape drift breaks zod validation | Medium | Medium | Library fails loudly; consumer can use `responseTransform`; document upgrade path in CHANGELOG |
| R4 | Network outage during verify leaves transaction unacknowledged on Android beyond 3-day window | Low | Medium | Recovery on init re-attempts; log + alert if `unfinished_transactions` entries are >24h old |
| R5 | Apple sandbox testing diverges from production behavior for refund/revocation | Medium | Low | Phase 8 includes a real production purchase + refund roundtrip before tagging 0.1.0 |
| R6 | `@nossdev/iap` API needs breaking changes after first production usage | High (typical for 0.x) | Low | Stay below 1.0 until validated against ≥3 production apps; document each break in CHANGELOG |
| R7 | Cap 7 migration cost when Infopathy upgrades — adapter rewrite + plugin swap | Medium | Low | v7 adapter preserved in git commit `f1d20ed`; v7 plugin API surface preserved at `docs/internal/_future/plugin-v7-api.md`. Restoration is copy-paste + peer-dep bump (see §18). |

---

## 18. Capacitor 7 migration

✅ **Done (2026-05-12 / -14).** The `7.x` line is the Capacitor 7+ line built on `@capgo/native-purchases`, published as `7.0.0-next.N` prereleases on the `@next` npm dist-tag (was framed as `1.0.0-next.0` during development before the Capacitor-aligned renumber landed). The Capacitor 5 line lives on the `5.x` maintenance branch as `5.x` releases on `@latest` (renumbered from `0.4.x`, same code). `main` is now the in-dev Capacitor major (currently `7.x`). The notes below record what was done.

**What shipped:**

1. **Adapter restored from `f1d20ed`** — `git show f1d20ed:src/adapters/native/v7/native-adapter.ts` → `src/adapters/native/capgo/native-adapter.ts`, class renamed `V7NativeAdapter` → `CapgoNativeAdapter` (the `v7/` name was confusable with "Capacitor 7"; `capgo/` parallels the existing `cdv/`-named-after-the-plugin convention). Wraps `@capgo/native-purchases@7.16.2` against the unchanged `NativeAdapter` interface — no core-flow changes (only comment cleanup in `purchase-flow.ts` / `restore-flow.ts` / `types.ts` / `errors.ts` / `createIAP.ts`).
2. **Plugin API doc moved** — `docs/internal/_future/plugin-v7-api.md` → `docs/internal/plugin-v7-api.md`; `docs/internal/cdv-purchase-api.md` deleted (lives on the `5.x` branch for the Cap-5 line).
3. **`package.json`** — peerDeps: `@capacitor/core`/`@capacitor/preferences`/`@capacitor/app` → `^7.0.0 || ^8.0.0`; added `@capgo/native-purchases: 7.16.x || ^8.0.0` (lower bound `7.16.x`, *not* `^7.0.0` — `7.17+` requires Cap 8 per `docs/internal/plugin-v7-api.md`); removed `cordova-plugin-purchase`. devDeps: added `@capgo/native-purchases@7.16.2`, bumped `@capacitor/*` to `^7`, removed `cordova-plugin-purchase`. **Kept `jsdom`** — `@capacitor/preferences`' web fallback reads `window.localStorage`, so vitest stays on `environment: 'jsdom'` (the original plan said switch to `'node'`; that was wrong).
4. **`src/adapters/native/index.ts`** — `selectNativeAdapter()` dynamic-imports `./capgo/native-adapter.js`; dropped the `{ products }` option (the capgo adapter has no `store.register()` bootstrap). Single-binary Cap-5/Cap-7 coexistence was rejected (unsatisfiable `@capacitor/core ^5` vs `^7` peer-dep conjunction).
5. **Version** — `7.0.0-next.0` via `mise run publish` from `main`. The publish task accepts stable + prerelease from `main` and matching-major stable from `<major>.x` branches; see the project memory "Versioning + branch model — Capacitor-aligned" for the full model.
6. **README support matrix** and the docs site (`installation.md`, `migration/index.md`, `getting-started.md`, `architecture.md`, `safety-guarantees.md`, `error-handling.md`, `guide/index.md`, `index.md`, `api/*`, `.vitepress/config.ts`, `CHANGELOG.md`) updated for Capacitor 7+ / `@capgo/native-purchases` / the `@next` dist-tag.
7. **Tests** — `tests/unit/native-adapter.test.ts` rewritten with a `CapgoNativeAdapter` block (mocks `@capgo/native-purchases`); `tests/mocks/mock-cdv-purchase.ts` deleted. The iOS `transactionUpdated` / `transactionVerificationFailed` listeners were *not* wired — recovery replays from the `unfinished_transactions` store and `refreshOnResume` reconciles server-side renewals; they'd be a future additive optional `NativeAdapter` method.

The public `IAP<TEntitlement>` API did not change. Consumer apps bump peer deps and run `npx cap sync`.

---

*End of plan. Pair this with the Attesto integration guide at https://attesto.nossdev.com/guide/integration for the full client ↔ backend ↔ Attesto picture.*
