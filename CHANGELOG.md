# Changelog

All notable changes to `@nosslabs/iap` will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [8.0.0] — 2026-08-17

**Opens the Capacitor 8 line.** Same library, next platform major: the peer
range moves from Capacitor 7 to Capacitor 8, and nothing else changes. Cap-7
consumers stay on `7.x` — `^7` ranges don't auto-resolve to `8.x`.

### Changed (BREAKING, vs `7.1.0` — peer range only)

- **Anchored the `8.x` line to Capacitor 8.** Peer dependencies moved to
  `@capacitor/core`, `@capacitor/preferences` and (optional) `@capacitor/app`
  at `^8.0.0`, and `@capgo/native-purchases` at `^8.0.0`. The Cap-7 ranges
  (`@capacitor/*: ^7.0.0`, `@capgo/native-purchases: ^7.16.2`) are dropped —
  they were the only thing blocking a clean `npm install` in a Capacitor 8 app.
  Upgrading is a peer-dep bump plus `npx cap sync`.

### Notes

- **No runtime API changes.** `createIAP({ ... })` config, the `IAP` instance
  surface, the event map, the error codes and the backend contract are all
  byte-for-byte what `7.1.0` shipped. Nothing in `src/` needed a call-site fix:
  every `@capgo/native-purchases` method this library calls
  (`isBillingSupported`, `getProducts`, `purchaseProduct`, `getPurchases`,
  `acknowledgePurchase`, `manageSubscriptions`, `getStorefront`) keeps its
  `7.16.2` signature in `8.6.5`. The plugin's v8 additions — `consumePurchase()`,
  `presentOfferCodeRedeemSheet()`, the `billingPlanType` purchase option, the
  `onlyCurrentEntitlements` filter on `getPurchases()`, and the StoreKit
  commitment/renewal metadata on `Product` and `Transaction` — are all optional
  and none are consumed.
- **`getStorefront()` keeps its capability probe.** The plugin declares
  `getStorefront()` on its TypeScript interface as of `8.5.0`, but the peer
  range also admits `8.0.0`–`8.4.x`, which don't register the native method. The
  adapter therefore still gates on the Capacitor plugin header rather than the
  declared type, and still resolves `null` when the method is absent — including
  for the plugin's own "storefront unavailable" signal, an empty `countryCode`.

## [7.1.0] — 2026-07-04

### Added

- `iap.getStorefront(): Promise<Storefront | null>` — reads the user's App
  Store / Google Play storefront (the country their store account is registered
  to). Returns the new exported `Storefront` type, with `countryCode` normalized
  to ISO 3166-1 alpha-2 across platforms (iOS reports alpha-3, Android alpha-2);
  the raw native value is preserved on `countryCodeRaw`, plus the Apple
  `storefrontId` (iOS only) and `platform`. Resolves `null` on web, when the
  installed `@capgo/native-purchases` build doesn't register the native
  `getStorefront` method, or when the storefront is unavailable (e.g. EU
  alternative distribution). Read it live and treat it as a UX/targeting hint —
  for compliance/entitlement decisions, trust the server-side signed storefront.

### Changed

- Anchored the `7.x` line to **Capacitor 7**: peer dependencies narrowed to
  `@capacitor/*: ^7.0.0` and `@capgo/native-purchases: ^7.16.2` (dropping the
  `^8.0.0` allowances). The `^7.16.2` range admits the Capacitor-7 capgo build
  that adds native `getStorefront`. Capacitor-8 support will ship in
  `@nosslabs/iap` v8. (`getStorefront()` itself still degrades gracefully on
  capgo builds that predate the native method.)

## [7.0.0] — 2026-05-14

**GA of the Capacitor 7+ line.** `@latest` on npm moves from `5.0.0`
(Cap-5 maintenance) to `7.0.0` (Cap-7+). Cap-5 consumers stay on
`5.x` — `^5` ranges don't auto-resolve to `7.x`. The `5.x` maintenance
branch continues to receive patches.

### Changed (BREAKING, vs `5.0.0` — bundled with the Cap-5→Cap-7 swap)

- **EventMap pruning.** Removed two events from the public
  `EventMap` that were declared but never emitted in any prior
  release: `'price-stale'` and `'error'`. Subscriptions to either
  never fired, so no runtime behavior changes — only consumers who
  had `iap.on('price-stale', …)` or `iap.on('error', …)` in their
  TypeScript code need to remove those calls. The
  `'recovery-dropped-permanent'` event (introduced in 0.4 / `5.0.0`)
  remains.
- `IAPErrorOptions` is now file-local (was wrongly exported from
  `src/lib/errors.ts` but never re-exported through `src/index.ts`,
  so no consumer had access to it). No package-root-exported symbol
  changes.

### Added

- **`AppUserIdFetcherContext`** is now re-exported from the package
  root, so a separately-defined async fetcher can be typed
  explicitly:

  ```ts
  import type { AppUserIdFetcherContext } from '@nosslabs/iap';

  const fetchUuid = async ({ authHeaders }: AppUserIdFetcherContext) => {
    const r = await fetch('/api/iap/uuid', { method: 'POST', headers: authHeaders });
    return (await r.json()).uuid;
  };
  ```

### Fixed (since `7.0.0-next.0`)

- **iOS `Cannot find product for id <id>` now maps to
  `PRODUCT_NOT_FOUND`** (previously fell through to `STORE_ERROR`).
  The capgo plugin uses two different messages for the same
  semantic on iOS vs Android; the adapter now handles both.
- **`refresh()` is safe to detach from the IAP instance.** Internal
  callbacks no longer reference `this.refresh()`, so
  `const { refresh } = iap;` works without a strict-mode `this`
  binding error. Regression test added.

### Notes

- Adapter JSDoc for `getOwnedTransactions()` now documents an iOS
  quirk worth knowing: `@capgo/native-purchases`'s `getPurchases()`
  bundles `Transaction.currentEntitlements` *plus* `Transaction.all`
  (historical + revoked subscriptions). Android-side PENDING
  purchases are filtered out (`purchaseState !== '1'`); iOS-side
  historical transactions are not filtered and pass through to the
  backend's `/restore` endpoint. Attesto evaluates each receipt and
  returns per-transaction validity, so this is the documented
  contract.
- Android user-cancellation reminder (carried from `7.0.0-next.0`):
  Google Play Billing collapses user-cancel and other billing
  errors into the same plugin rejection, so an Android cancel
  surfaces as `status: 'failed'` rather than `'cancelled'`. iOS
  still distinguishes reliably.

## [7.0.0-next.0] — 2026-05-14

First release of the **Capacitor 7+** line, published on the `@next`
npm dist-tag. The Capacitor 5 line continues as `5.x` on `@latest`
(from the `5.x` branch) — see [Migration](https://iap.nossdev.com/migration/).

Numbering: the library's major version tracks the Capacitor major it
targets (the convention `@capgo/native-purchases` and Ionic plugins
use). What was framed as `1.0.0-next.0` during development is published
as `7.0.0-next.0` for the same reason `5.0.0` superseded `0.4.0` on
the maintenance line — same code, version aligned with the platform.

### Changed

- **BREAKING: dropped Capacitor 5 support.** The `7.x` line targets
  **Capacitor 7+** (also runs on Capacitor 8) via
  [`@capgo/native-purchases`](https://github.com/Cap-go/native-purchases),
  replacing `cordova-plugin-purchase`. The native adapter now lives at
  `src/adapters/native/capgo/native-adapter.ts` (`CapgoNativeAdapter`),
  selected behind the same `NativeAdapter` interface as before.
- **Peer dependencies** are now `@capacitor/core`, `@capacitor/preferences`,
  and (optional) `@capacitor/app` at `^7.0.0 || ^8.0.0`, plus
  `@capgo/native-purchases` at `7.16.x || ^8.0.0`. `cordova-plugin-purchase`
  is no longer a peer dependency. Migration is a peer-dep swap + `npx cap sync`
  — no changes to your `createIAP({ ... })` config or any consumer code.
- **Acknowledgement defers on both platforms.** `@capgo/native-purchases`
  supports `autoAcknowledgePurchases: false` on iOS and Android, so the
  "never grant entitlement before the backend confirms" guarantee holds
  with no iOS-specific finish-before-verify race.
- **Android user-cancellation surfaces as `status: 'failed'`** (not
  `'cancelled'`). Google Play Billing — at the level `@capgo/native-purchases`
  exposes — doesn't distinguish a user-cancelled flow from other purchase
  failures; iOS still reports `'cancelled'` reliably. Treat `failed` on
  Android the same as `cancelled` for UX. (The Capacitor 5 line via
  `cordova-plugin-purchase` could distinguish this.)

### Unchanged

- Public API surface: `createIAP`, the `IAP` interface, all events, all
  `IAPErrorCode` values, and every public type are identical to `5.0.0`
  (= `0.4.0` code).
- The full `0.2`–`0.4` feature set carries forward: the options-object
  `purchase()` signature, optional `appUserId` pre-attachment, the
  `INVALID_APP_USER_ID` / `APP_USER_ID_FETCH_FAILED` error codes, the
  `permanentErrorCodes` config, the `recovery-dropped-permanent` event,
  and `RecoveryResult.droppedPermanent`.

## [0.4.0] — 2026-05-08

### Added

- **`options.permanentErrorCodes` config** — list of backend
  `valid:false` error codes that recovery should treat as permanent.
  Entries with a matching error are removed from
  `unfinished_transactions` storage instead of being retried on every
  app launch. Defaults to `['TRANSACTION_NOT_FOUND', 'PRODUCT_MISMATCH']`
  per the documented recipe contract — the two codes that mean "the
  backend looked and the answer is permanently no, this transaction is
  not valid." When provided, the option REPLACES the default (no magic
  merge); pass `[...DEFAULT_PERMANENT_ERROR_CODES, 'YOUR_CODE']` to
  extend, or `[]` to disable the feature entirely (revert to
  retry-forever behavior).

  ```ts
  import { createIAP, DEFAULT_PERMANENT_ERROR_CODES } from '@nosslabs/iap';

  // Default: TRANSACTION_NOT_FOUND and PRODUCT_MISMATCH are dropped.
  createIAP({ /* ... */ });

  // Extend with your backend's custom permanent codes.
  createIAP({
    options: {
      permanentErrorCodes: [...DEFAULT_PERMANENT_ERROR_CODES, 'MY_CUSTOM_CODE'],
    },
  });

  // Opt out entirely — every valid:false retains the entry for retry.
  createIAP({
    options: { permanentErrorCodes: [] },
  });
  ```

- **`'recovery-dropped-permanent'` event** — fires once per entry
  removed by the new classifier. Payload:
  `{ productId, token, error, message? }`. Useful for ops
  observability when a stuck-loop self-heals.

- **`DEFAULT_PERMANENT_ERROR_CODES` exported** from the package root
  for the spread-then-extend pattern above.

- **`RecoveryResult.droppedPermanent`** — new field on the recovery
  result alongside `recovered` and `failures`. Counts how many
  entries were removed during the current sweep.

### Changed

- **Recovery no longer retries `valid:false` responses with
  permanently-invalid error codes** (default:
  `TRANSACTION_NOT_FOUND`, `PRODUCT_MISMATCH`). Previous behavior is
  preserved for any code not in the permanent set, and is
  configurable via `options.permanentErrorCodes`. Strict improvement
  for the cases it affects (stuck loops self-heal); other paths
  unchanged. **Bumped to a minor version** because the behavior is
  observable — consumers asserting on `RecoveryResult` shape or
  intentionally depending on retry-forever semantics for a specific
  code should opt out via `permanentErrorCodes: []`.

  > **Backend assumption.** The default set assumes your backend
  > queries Apple App Store Server API / Google Play Developer API
  > with eventually-consistent reads (typical for Attesto's recipe
  > pattern). If your backend reads from a replicated database with
  > replication lag exceeding app-launch cadence, a `TRANSACTION_NOT_FOUND`
  > response could be transient — in that case configure
  > `permanentErrorCodes: []` (or a custom set) until you've reconciled
  > the lag.

## [0.3.1] — 2026-05-06

### Added

- **`appUserId` async fetcher may now accept an optional `ctx`
  parameter.** The library passes `{ authHeaders }` populated from
  `backend.getAuthHeaders()` (resolved fresh per purchase), letting
  consumers reuse the same auth they configured for IAP-backend
  requests when their UUID-minting endpoint uses that same auth.
  The parameter is optional convenience, not contract — zero-arg
  fetchers from 0.2.x continue to work unchanged. Ignore the
  parameter when your UUID endpoint uses different auth and close
  over your own auth state instead. For consumers using a custom
  `BackendAdapter` (no `getAuthHeaders` configured), `ctx.authHeaders`
  is `{}`.

  ```ts
  // before — still valid
  appUserId: async () => {
    const r = await fetch('/api/iap/uuid', { method: 'POST', headers: authHeaders() });
    return (await r.json()).uuid;
  }

  // after — equivalent, no helper duplication
  appUserId: async ({ authHeaders }) => {
    const r = await fetch('/api/iap/uuid', { method: 'POST', headers: authHeaders });
    return (await r.json()).uuid;
  }
  ```

  See `docs/guide/getting-started.md` (Pre-attaching a user identifier)
  and `docs/api/types.md` (`AppUserId`) for the updated reference.

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
