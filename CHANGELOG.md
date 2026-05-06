# Changelog

All notable changes to `@nosslabs/iap` will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] — 2026-05-06

### Changed (BREAKING)

- **Package renamed: `@nossdev/iap` → `@nosslabs/iap`.** Update your install
  and import sites:
  ```
  npm uninstall @nossdev/iap
  npm install @nosslabs/iap
  ```
  ```ts
  // before
  import { createIAP } from '@nossdev/iap';
  // after
  import { createIAP } from '@nosslabs/iap';
  ```
  Behavior is unchanged. The rename disambiguates registry routing for
  consumers that point `@nossdev:*` at a private registry — previously,
  any `.npmrc` mapping `@nossdev` to a private feed would also intercept
  the public `@nossdev/iap` lookup. The `@nossdev/iap` package on npm
  remains installable at its existing versions but receives no further
  updates under that name.

- **Default storage namespace: `nossdev_iap` → `nosslabs_iap`.** On
  upgrade, prior cached entitlements are not read. The library refetches
  from the backend on first `getEntitlements()` / `restorePurchases()`
  call, so no manual migration is required. If you depend on cache
  continuity across the upgrade, set
  `storage: { namespace: 'nossdev_iap' }` explicitly in your IAP config
  to keep reading the old key.

- **Logger console prefix: `[@nossdev/iap]` → `[@nosslabs/iap]`.** Update
  any log-grep dashboards or filters keyed on the old prefix.

### Migration

No API changes. Drop-in once the package name and (optionally) the
storage namespace override are updated.

## [0.2.0] — 2026-05-06

### Changed (BREAKING)

- **`purchase()` signature is now an options object.** Replace `iap.purchase('premium_monthly')` with `iap.purchase({ productId: 'premium_monthly' })`. The new shape is required for the additive `appUserId` field below and any future per-purchase options. Search-and-replace migration; one mechanical edit per call site. See [Migration § v0.1 → v0.2](https://iap.nossdev.com/migration#v0-1-v0-2-breaking-purchase-signature).

### Added

- **Pre-attached `appUserId` for the verify/webhook user-mapping path.** New optional `appUserId` field on `PurchaseOptions` accepts either a UUID v4 string or an async fetcher (`() => Promise<string>`). When supplied, the resolved value is validated as a UUID v4 and forwarded to StoreKit's `appAccountToken` (iOS) / Play Billing's `obfuscatedAccountId` (Android) — making it available to the consumer's backend on Attesto's verify response and outbound webhook payload as a top-level `appUserId` field. Eliminates the verify/webhook race for purchases where the user is signed in. Fetcher is invoked fresh per purchase; no iap-side caching (backend owns the mint-or-lookup idempotency). See [Getting started § Pre-attaching a user identifier](https://iap.nossdev.com/guide/getting-started#pre-attaching-a-user-identifier-optional).
- **`AppUserId` and `PurchaseOptions` types** exported from the package root for consumers who type their own helpers around `purchase(...)`.
- **Two new error codes**:
  - `INVALID_APP_USER_ID` — supplied value (literal or fetcher-returned) isn't a valid UUID v4. Thrown synchronously / via Promise rejection, before reaching the native adapter.
  - `APP_USER_ID_FETCH_FAILED` — async fetcher threw or rejected. Original error is attached as `cause` for introspection.

## [0.1.3] — 2026-05-06

### Fixed

- **Restore response no longer requires a `transaction` envelope.** `HttpBackendAdapter.restore()` previously validated against the same schema as `verifyApple` / `verifyGoogle`, which required `transaction: { id, productId, ... }` on success. The orchestrator never reads `response.transaction` on the restore path — `iap.restorePurchases()` returns `{ restored, entitlements }` and the field was never surfaced. Backends may now respond with `{ valid: true, entitlements: [...] }` and the library accepts it. Backends that include `transaction` aren't broken — the field is preserved (passthrough) but no longer validated.
- **Top-level response envelopes now passthrough unknown keys.** Every backend response schema (`verifyResponseSchema`, the new `restoreResponseSchema`, `entitlementsResponseSchema`, `productManifestResponseSchema`) used `z.object()`'s strip-unknown default, silently dropping consumer-defined extras (analytics ids, debug fields, server timestamps, custom flags). Inner schemas (`passthroughEntitlementSchema`, `verifiedTransactionSchema`) already passed through; this patch closes the top-level gap so backend metadata rides through end-to-end. Consumer code can read these extras via a runtime cast — the library validates only the named fields it owns.

### Changed

- **`BackendAdapter.restore()` return type** is now `RestoreResponse<T>` rather than `VerifyResponse<T>`. The success branch omits the `transaction` field; the failure branch is unchanged. Existing custom adapters returning `VerifyResponse` from `restore()` remain structurally compatible — `{ valid: true; entitlements; transaction }` is assignable to `{ valid: true; entitlements }`. Update your typings opportunistically.
- **`transaction.verifiedAt` no longer validated** in the runtime schema. The library never read it; consumers that send it still see it preserved via the existing `verifiedTransactionSchema.passthrough()`.

## [0.1.2] — 2026-05-05

### Fixed

- **`androidPlanId` no longer required for subscription products** — the schema previously enforced `androidPlanId` cross-platform via a `.refine()` on `configuredProductSchema`, blocking iOS-only consumers and single-plan Android subscriptions from validating their config or backend manifest. The field is now consistently optional. The Android native adapter already falls back to `native.getOffer()` (the default offer) when it's missing, so the runtime is unaffected. Set `androidPlanId` explicitly only when an Android subscription has multiple base plans and you need to disambiguate. iOS ignores it.
- **`verifyApple` / `verifyGoogle` are individually optional** — previously both were required at the schema level even for single-platform builds. Now at least one of them must be set; the other can be omitted. iOS-only consumers can drop `verifyGoogle`, Android-only consumers can drop `verifyApple`. The HTTP adapter throws `IAPError(INVALID_CONFIG)` with a clear message if the runtime ever dispatches to a missing endpoint — but in practice the orchestrator only calls the endpoint matching the active native transaction's platform.

## [0.1.1] — 2026-05-05

### Fixed

- **HTTP client URL normalization** — `HttpClient` now forgives mismatched slashes between `backend.baseUrl` and `backend.endpoints.*`. Previously, only a trailing slash on `baseUrl` was stripped; an endpoint path without a leading slash silently produced a malformed URL (`https://api.example.comiap/verify`). Both sides are now normalized: `baseUrl` trailing slashes (including `//`) are stripped and a leading `/` is added to the endpoint path if missing. No behavior change for correctly-configured consumers.

## [0.1.0] — 2026-04-29

First public release. Capacitor 5 IAP orchestrator that defers acknowledgement to a backend you control.

### Added

- **`createIAP({ products, backend })` factory** — Promise-based public API. Returns an instance with `initialize()`, `purchase()`, `restore()`, `refresh()`, `getEntitlements()`, `hasEntitlement()`, and a typed event emitter.
- **Capacitor 5 native adapter** — wraps [`cordova-plugin-purchase`](https://github.com/j3k0/cordova-plugin-purchase) `^13.x`. Defers `Transaction.finish()` until backend verification succeeds (the "never grant before backend confirms" guarantee). Web stub no-ops gracefully.
- **Backend HTTP client** — fetch wrapper with timeout, stepped retry on 5xx (1 s / 2 s / 4 s, no retry on 4xx), pluggable `getAuthHeaders`, request/response transforms, and structured error mapping to `IAPError` with `IAPErrorCode` enum.
- **Backend abstraction** — `BackendAdapter` interface with optional methods (`verifyApple`, `verifyGoogle`, `entitlements`, `restore`, `listProducts`). Bring your own adapter (Firebase, Supabase, GraphQL) or use the built-in HTTP adapter.
- **Backend-driven product manifest** — `createIAP({ products })` is optional. Set `backend.endpoints.products` (HTTP) or implement `listProducts()` on a custom adapter to have the backend curate the SKU list. Hard caveat: every SKU must still be pre-registered in App Store Connect / Google Play Console.
- **Purchase flow orchestration** — captures the cdv `Transaction` in `pendingFinish`, calls backend `verifyApple`/`verifyGoogle`, only then triggers `nativeAdapter.acknowledge()`. Concurrency lock prevents double-purchase. Emits `purchase-started`, `purchase-success`, `purchase-failed`, `purchase-cancelled`, `purchase-pending`, `verification-failed`.
- **Restore flow** — `iap.restore()` re-fetches owned items, surfaces newly granted entitlements, deduplicates against the local cache.
- **Refresh + recovery** — `iap.refresh()` reconciles `unfinished_transactions` storage on app resume / launch; recovery on `initialize()` re-attempts verification for transactions that died between native success and ack.
- **Entitlement cache** — Capacitor Preferences-backed (with in-memory fallback for tests/web). Survives app restarts. Sync reads via `getEntitlements()` / `hasEntitlement()` for fast UI.
- **Configurable logger** — `Logger` interface with a default console-backed implementation. Inject a structured logger (Sentry, Datadog) for production observability.
- **Documentation site** — VitePress at [iap.nossdev.com](https://iap.nossdev.com): installation, configuration, backend contract, API reference, and recipes for Vue + Quasar, React, and Pinia store.
- **CI** — typecheck + lint + test + build on Node 20 and 22, matrix run on every PR and push to `main`.

### Notes for early adopters

- API may have breaking changes through the 0.x line as production usage exposes rough edges. Pin the minor (`^0.1.0`) and watch this CHANGELOG.
- Capacitor 7 migration is preserved in git history (commit `f1d20ed`); the v7 native adapter ships as a separate major (`1.x`) when the consumer ecosystem catches up.

### Future

- Upgrade `zod` from 3 to 4 once the wider ecosystem catches up.
- Migrate from `NPM_TOKEN` to npm OIDC trusted publishers.
- Capacitor 7 + `@capgo/native-purchases v7.x` adapter.
