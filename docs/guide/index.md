# What is `@nossdev/iap`?

`@nossdev/iap` is a thin, framework-agnostic TypeScript library that orchestrates the in-app purchase flow on the **client side** of a Capacitor app. It wraps [`cordova-plugin-purchase`](https://github.com/j3k0/cordova-plugin-purchase) and coordinates with **your backend**, which in turn talks to [Attesto](https://attesto.nossdev.com) for receipt validation.

This library is the client-side counterpart to Attesto. **Attesto** answers _"is this transaction real?"_ on the server. **`@nossdev/iap`** answers _"how do we orchestrate the purchase flow and entitlement state cleanly on the client?"_

## Why it exists

Without this library, every Capacitor app reimplements the same orchestration pattern:

1. Call native plugin to start purchase
2. Receive transaction token from native side
3. Send token to your backend for validation
4. Wait for backend response
5. **Only after backend confirms**, call `tx.finish()` on the plugin
6. Update local entitlement cache
7. Emit events so UI can react
8. Handle restore flow
9. Handle pending / interrupted transactions on app launch
10. Persist entitlement state to survive app restarts

That's a lot of orchestration to get right. `@nossdev/iap` encapsulates it once, correctly, and makes it consumable across all your apps.

## Design philosophy: thin wrapper, not a framework

`@nossdev/iap` is **not** RevenueCat-on-the-client. It does **one thing**: orchestrate the purchase + verification + entitlement-caching dance against a backend you control.

### What it DOES

- Wrap `cordova-plugin-purchase` for purchase + restore flows
- POST to a configurable backend endpoint for verification
- Acknowledge native transactions only **after** the backend confirms
- Cache entitlements locally for instant UI reads
- Emit events for UI reactivity (`entitlements-changed`, `purchase-success`, etc.)
- Handle pending / interrupted transactions on app resume + launch
- Provide a clean Promise-based public API
- Be framework-agnostic (works with Vue/Quasar, React, Svelte, vanilla TS)

### What it does NOT

- Talk to Attesto directly (your backend does)
- Implement receipt validation logic (Attesto does)
- Define entitlement business rules (your backend does)
- Manage user authentication (your app does)
- Provide UI components (paywalls, product cards, etc.)
- Render product names or prices (your UI is responsible — App Store requires displaying values from the native plugin)
- Handle promo codes, A/B testing, subscription state machines

This boundary is **non-negotiable**. If a feature request encroaches on entitlement business logic or paywall UI, push back — that belongs in your app, not the library.

## Three-tier model

```
┌────────────────────────────────────────────────────────┐
│ Consumer App (Vue / Quasar / React / Svelte)           │
│   await iap.purchase({ productId: 'premium_monthly' }) │
│   iap.hasEntitlement('premium')                        │
│   iap.on('entitlements-changed', ...)                  │
└────────────────────────────────────────────────────────┘
                         ↕
┌────────────────────────────────────────────────────────┐
│ @nossdev/iap (this library)                            │
│   - orchestrates purchase flow                         │
│   - coordinates with backend                           │
│   - manages entitlement cache                          │
│   - emits reactive events                              │
└────────────────────────────────────────────────────────┘
              ↓                            ↓
   ┌─────────────────────┐    ┌──────────────────────┐
   │ cordova-plugin-     │    │ Your backend         │
   │ purchase (native)   │    │ (HTTP API)           │
   │ → StoreKit/Billing  │    │ → calls Attesto      │
   └─────────────────────┘    └──────────────────────┘
                                         ↓
                              ┌──────────────────────┐
                              │ Attesto              │
                              │ (receipt validation) │
                              └──────────────────────┘
```

Three architectural rules drive the design:

1. **The library NEVER calls Attesto directly.** Attesto API keys are server credentials. The library only calls your backend; your backend calls Attesto.
2. **Your backend is the source of truth for entitlements.** The library caches them locally for performance, but always defers to backend state on refresh.
3. **`tx.finish()` only happens AFTER backend validation succeeds.** This is the core safety guarantee — see [Safety guarantees](/guide/safety-guarantees).

## Next steps

- [Getting started](/guide/getting-started) — install + first purchase in under 30 minutes
- [Architecture](/guide/architecture) — how the layers compose
- [Backend contract](/guide/backend-contract) — what your backend must implement
