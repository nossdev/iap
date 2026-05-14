# Architecture

`@nosslabs/iap` is a thin orchestrator that sits between your UI and three independent systems: the native store, your backend, and Attesto. This page shows how those pieces compose.

## Three-tier model

```
┌──────────────────────────────────────────────────────────┐
│ Consumer App                                             │
│   - Vue / React / Svelte / vanilla TS                    │
│   - Calls iap.purchase, iap.hasEntitlement, iap.on(...)  │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│ @nosslabs/iap (this library — runs in the WebView)        │
│   - Orchestrates the purchase + verify + finish dance    │
│   - Caches entitlements locally for instant reads        │
│   - Recovers unfinished transactions on launch / resume  │
│   - Emits typed events                                   │
└──────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│ cordova-plugin-purchase  │    │ Your backend (HTTP/JSON) │
│   (native iOS/Android)   │    │   - /verify/apple        │
│   - StoreKit 2 (iOS)     │    │   - /verify/google       │
│   - Play Billing 7       │    │   - /entitlements        │
│                          │    │   - /restore             │
└──────────────────────────┘    └──────────────────────────┘
                                              │
                                              ▼
                                ┌──────────────────────────┐
                                │ Attesto                  │
                                │  (receipt validation)    │
                                └──────────────────────────┘
```

## Layer responsibilities

### Consumer app

- Knows about UI: paywalls, premium gating, restore buttons.
- Holds user authentication state — provides `getAuthHeaders()` for backend calls.
- Subscribes to `entitlements-changed` to drive reactive state (Pinia / React stores).
- **Does not** know what a receipt is, how to talk to Attesto, or when to call `tx.finish()`.

### `@nosslabs/iap`

- Talks to the native plugin to start purchases and observe transaction events.
- Talks to **your** backend (never Attesto directly) to verify receipts.
- Acknowledges native transactions only **after** the backend confirms (see [Safety guarantees](/v5/guide/safety-guarantees)).
- Persists entitlements + unfinished-transaction queue via `@capacitor/preferences`.
- Stays small — no UI, no business rules, no auth.

### Native plugin (`cordova-plugin-purchase`)

- Bridges to StoreKit 2 (iOS 15+) and Google Play Billing 7 (Android API 21+).
- Hands the library a transaction with a token (Apple `transactionId` or Google `purchaseToken`).
- Honours **deferred finish** — the transaction stays open until we explicitly call `finish()`. Critical for the safety guarantee.

### Your backend

- Receives `{ platform, token, packageName?, productType }` from the library.
- Calls Attesto to validate the receipt.
- Translates Attesto's verdict into your **app-specific entitlements** (e.g. `tier: 'pro'`, feature flags, expiry dates).
- Returns `{ valid: true, transaction, entitlements }` or `{ valid: false, reason }`.
- Owns user ↔ entitlement linkage in your database.

See [Backend contract](/v5/guide/backend-contract) for the exact request/response shapes.

### Attesto

- Receipt validation as a service.
- Single source of truth for "is this Apple/Google receipt real and current?".
- Your backend's API key never leaves the server.

## Data flow: a successful purchase

```
1. UI                  iap.purchase({ productId: 'premium_monthly' })
2. library  → plugin   storefront.order(productId)
3. plugin   → store    StoreKit / Play Billing dialog
4. user                taps Buy, authenticates
5. store    → plugin   transaction { token, productId }
6. plugin   → library  receiveTransaction(...)
7. library             persist to unfinished_transactions
8. library  → backend  POST /verify/apple { token, ... }
9. backend  → Attesto  validate receipt
10. Attesto → backend  { valid: true, ... }
11. backend → library  { valid: true, transaction, entitlements }
12. library → plugin   transaction.finish()              ← only now!
13. library            update entitlement cache + remove from queue
14. library            emit 'purchase-success', 'entitlements-changed'
15. UI                 reactive store updates → premium UI shows
```

If anything fails between step 8 and step 11, the transaction stays in the unfinished queue — the next launch (or `iap.refresh()`) will retry from step 8. That's the [at-least-once recovery](/v5/guide/safety-guarantees#at-least-once-recovery) guarantee.

## Why a thin client?

Every alternative we considered violated one of two principles:

1. **Server-side credentials must stay server-side.** Attesto API keys cannot live in a mobile app — even obfuscated. A thicker client either holds those keys (insecure) or duplicates Attesto on the client (impossible — Apple/Google only sign receipts for backend verification).
2. **Entitlement business logic belongs to the app, not a vendor.** Your tiers, feature flags, free trials, family plans, grace periods — those are product decisions. Encoding them in a third-party SDK means you're stuck with their model. Encoding them in your backend means you can iterate freely.

The library does the orchestration that's identical across all Capacitor IAP apps. Your backend does the parts that are unique to your product.

## Web platform

The library runs in the WebView too. On web:

- `iap.purchase()` and `iap.restorePurchases()` reject with `IAPError(PLATFORM_NOT_SUPPORTED)`.
- `iap.getProducts()` returns `[]`.
- Entitlement reads (`hasEntitlement`, `getEntitlements`) work — they read from `localStorage` (Capacitor Preferences fallback). Useful for SSR-style SPA development.
- `iap.refresh()` works — it's a plain HTTP call to your backend.

This means you can develop your premium UI in a desktop browser, and entitlement-gated UI will render based on the last sync from a real device.

## Next

- [Safety guarantees](/v5/guide/safety-guarantees) — what `tx.finish()` after backend confirms means
- [Backend contract](/v5/guide/backend-contract) — the four endpoints your backend implements
- [Events](/v5/guide/events) — full event reference
