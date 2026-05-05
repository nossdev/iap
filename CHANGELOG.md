# Changelog

All notable changes to `@nossdev/iap` will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
