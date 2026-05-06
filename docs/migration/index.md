# Migration

`@nossdev/iap` v0.x is the **Capacitor 5** line, built on `cordova-plugin-purchase`. Future major versions will support newer Capacitor releases via different native plugins.

## v0.1 → v0.2 (breaking: `purchase()` signature)

The `purchase()` method moved from a positional `productId` string to an options object so future per-purchase fields (starting with `appUserId`) can be added without further breakage:

```typescript
// v0.1.x — before
await iap.purchase('premium_monthly');

// v0.2.0 — after
await iap.purchase({ productId: 'premium_monthly' });
```

That's the only required change. Everything else (config, events, error codes, return shape) is unchanged. Run a search-and-replace:

```text
iap.purchase('<productId>')   →   iap.purchase({ productId: '<productId>' })
iap.purchase("<productId>")   →   iap.purchase({ productId: "<productId>" })
```

### What's new (additive — no action required)

The new options object accepts an optional `appUserId` to pre-attach a user identifier to the StoreKit / Play Billing purchase. Travels through to Attesto's verify response and outbound webhook payload as a top-level `appUserId` field — backends can join on user identity directly instead of falling back to subject.key mapping. See [Getting started § Pre-attaching a user identifier](/guide/getting-started#pre-attaching-a-user-identifier-optional) for the patterns. Two new error codes (`INVALID_APP_USER_ID`, `APP_USER_ID_FETCH_FAILED`) cover validation / fetcher failures.

If you're not ready to wire the backend mint-or-lookup endpoint, just don't pass `appUserId` — the new field is fully optional and existing flows behave identically to v0.1.

## Version compatibility

| Library version | Capacitor major | Native plugin                     | Status                |
|-----------------|-----------------|-----------------------------------|-----------------------|
| 0.1.x           | 5               | `cordova-plugin-purchase` (^13.x) | Superseded by 0.2.x   |
| 0.2.x           | 5               | `cordova-plugin-purchase` (^13.x) | **Current**           |
| 1.0.x           | 7+              | TBD (likely a Capacitor-native plugin) | Roadmap          |

Capacitor 6 is not on the roadmap as a separate target — Cap 5 → 7 will be the supported upgrade path.

## v0.1 → v1.0 (Capacitor 5 → 7)

When the v1.0 line ships, the public API surface (`createIAP`, `IAP` interface, events, errors, types) is intended to remain **source-compatible**. The migration effort will be:

- Update Capacitor dependencies (`@capacitor/core`, `@capacitor/preferences`, optional `@capacitor/app`) to v7.
- Replace `cordova-plugin-purchase` with the native Capacitor plugin selected for v1.x.
- Run `npx cap sync`.
- No changes to your `createIAP({ ... })` config or any consumer code.

We're committing to this stability target by isolating native-plugin specifics behind the `NativeAdapter` interface — same pattern that lets the library run on web today via the web-stub adapter. The `cordova-plugin-purchase` adapter lives in `src/adapters/native/v7/` (named for the cdv plugin's major; not Capacitor 7); switching plugins means writing a new adapter, not changing the public API.

## Why Capacitor 5 first

The user-facing decision driver (per the roadmap):

- The primary consumer app is on Capacitor 5 today and is blocked from publishing without IAP.
- Cap 5 → 7 upgrade has multiple breaking changes orthogonal to IAP; bundling IAP into that upgrade would gate the product launch.
- `cordova-plugin-purchase` is the only deferred-finish-capable plugin that works today on Cap 5 native bridge — and it's MIT-licensed and production-tested.

## Roadmap items affecting future migrations

| Roadmap item | Likely affects |
|---|---|
| Capacitor 7 native plugin | v1.0 — replaces cordova-plugin-purchase |
| Auto-refetch on `price-stale` | v0.2 — additive, no migration |
| TypeDoc-generated API docs | v0.2 — docs site only |
| Automatic schema fallback for legacy backends | v0.2 — additive `responseTransform` defaults |

See [PLAN.md §18](https://github.com/nossdev/iap/blob/main/PLAN.md) in the repo for the full roadmap.

## Reporting issues with the upgrade path

When v1.0 ships, this page will get a step-by-step migration guide. Until then:

- File a GitHub issue with your Capacitor / cordova-plugin-purchase versions and the failure mode.
- We'll prioritize compatibility shims for any consumer-visible breakage.

## See also

- [Installation](/guide/installation) — current version requirements
- [Architecture](/guide/architecture) — why the `NativeAdapter` boundary makes future plugin swaps non-breaking
