# Migration

`@nosslabs/iap` has three lines, **each numbered to match the Capacitor major it targets**:

- **`8.x`** — **Capacitor 8**, built on [`@capgo/native-purchases`](https://github.com/Cap-go/native-purchases) `^8`. The current line, on `@latest` (also `@latest-8`) — see [7.x → 8.x](#v7-to-v8) below.
- **`7.x`** — **Capacitor 7**, built on `@capgo/native-purchases` `lts-v7`. In maintenance — pin `^7` to stay on this line (also `@latest-7`). Docs: [v7](/v7/).
- **`5.x`** — **Capacitor 5**, built on `cordova-plugin-purchase`. In maintenance — pin `^5` to stay on this line (also `@latest-5`). Docs: [v5](/v5/).

Each line's peer range is scoped to its own Capacitor major, so `^5`, `^7` and
`^8` ranges each stay on their own line and never cross-resolve.

The public API surface (`createIAP`, the `IAP` interface, events, error codes, types) is the **same on all three lines** — moving between them is a peer-dependency swap, not a code rewrite.

## 7.x (Capacitor 7) → 8.x (Capacitor 8) {#v7-to-v8}

The `8.x` line is the current line, on `@latest`. If you install
`@nosslabs/iap` without a range you get it — pin `^7` to stay on Capacitor 7.

1. **Upgrade Capacitor** to 8 per the [Capacitor 8 migration guide](https://capacitorjs.com/docs/updating/8-0). This is the bulk of the work and is orthogonal to IAP. Capacitor 8 requires **Node 22+**, **iOS 15+**, and **Android `minSdk` 24**.
2. **Bump `@nosslabs/iap` and the native plugin:**

   ```bash
   npm install @nosslabs/iap @capgo/native-purchases
   ```
3. **Upgrade the Capacitor peer deps** you already have to v8 (`@capacitor/core`, `@capacitor/preferences`, and the optional `@capacitor/app`).
4. **Run `npx cap sync`.**
5. **No changes to your code.** The `createIAP({ ... })` config, the `IAP` instance surface, the event map, the error codes and the backend contract are byte-for-byte what `7.1.0` shipped. This upgrade is a peer-dependency bump, nothing more.

`getStorefront()` requires `@capgo/native-purchases` **>= 8.5.0** — earlier `8.x`
releases don't register the native method, and the library resolves `null`
rather than failing.

## 5.x (Capacitor 5) → 7.x (Capacitor 7) {#v5-to-v7}

1. **Upgrade Capacitor** to 7 per the [Capacitor migration guide](https://capacitorjs.com/docs/updating/7-0). This is usually the bulk of the work and is orthogonal to IAP.
2. **Swap the native plugin and bump `@nosslabs/iap`:**

   ```bash
   npm uninstall cordova-plugin-purchase
   npm install @nosslabs/iap@^7 @capgo/native-purchases@lts-v7
   ```

   Both packages are pinned here: npm's `latest` for `@nosslabs/iap` *and* for
   `@capgo/native-purchases` is now the Capacitor 8 line, so an unpinned install
   would land you on Capacitor 8 rather than 7.

   ::: tip Going straight from Capacitor 5 to Capacitor 8?
   Upgrade Capacitor to 8 rather than 7 in step 1, drop both pins in step 2, and
   use `@^8` in step 3:

   ```bash
   npm uninstall cordova-plugin-purchase
   npm install @nosslabs/iap @capgo/native-purchases
   ```

   Then read [7.x → 8.x](#v7-to-v8) for the Capacitor 8 platform minimums
   (Node 22+, iOS 15+, Android `minSdk` 24).
   :::
3. **Upgrade the Capacitor peer deps** you already have to v7 (`@capacitor/core`, `@capacitor/preferences`, and the optional `@capacitor/app`).
4. **Run `npx cap sync`** so the new plugin's native source is linked.
5. **No changes to your `createIAP({ ... })` config or any consumer code.** Same `purchase()`/`restore()`/`refresh()`/`getEntitlements()` API, same events, same error codes, same return shapes.

The whole 0.2–0.4 feature set (carried forward into `5.0.0` and now `7.x`) is unchanged: the options-object `purchase()` signature, optional `appUserId` pre-attachment, the `INVALID_APP_USER_ID` / `APP_USER_ID_FETCH_FAILED` error codes, and the recovery behaviour (permanently-invalid entries are dropped rather than retried forever).

### Why a new plugin

`cordova-plugin-purchase` reaches the device through Capacitor's Cordova compatibility bridge, which is the path Capacitor is steadily de-emphasising. `@capgo/native-purchases` is a first-class Capacitor plugin (StoreKit 2 on iOS, Google Play Billing on Android) and — crucially — supports `autoAcknowledgePurchases: false` on **both** platforms, so the library's "never grant before the backend confirms" guarantee holds with no iOS-specific finish-before-verify race. The plugin-version specifics are isolated behind the `NativeAdapter` interface (`src/adapters/native/capgo/native-adapter.ts`) — the same boundary that lets the library run on web via the web-stub adapter.

## Coming from `0.1.x` (historical — `purchase()` signature)

(Applies only if you skipped from a `0.1.x` release.) The `purchase()` method moved from a positional `productId` string to an options object:

```typescript
// 0.1.x — before
await iap.purchase('premium_monthly');

// 0.2.0+ — after (also carried into 5.x and 7.x)
await iap.purchase({ productId: 'premium_monthly' });
```

Search-and-replace:

```text
iap.purchase('<productId>')   →   iap.purchase({ productId: '<productId>' })
iap.purchase("<productId>")   →   iap.purchase({ productId: "<productId>" })
```

Everything else (config, events, error codes, return shape) is unchanged. The options object also accepts an optional `appUserId` — see [Getting started § Pre-attaching a user identifier](/guide/getting-started#pre-attaching-a-user-identifier-optional).

## Version compatibility

| Library version | Capacitor major | Native plugin | dist-tag | Status |
|---|---|---|---|---|
| 8.0.x | 8 | `@capgo/native-purchases` `^8` | `@latest`, `@latest-8` | **Current** |
| 7.1.x | 7 | `@capgo/native-purchases` `lts-v7` | `@latest-7` (pin via `^7`) | Maintenance |
| 5.0.x | 5 | `cordova-plugin-purchase` ^13.x | `@latest-5` (pin via `^5`) | Maintenance |
| 0.2.x – 0.4.x | 5 | `cordova-plugin-purchase` ^13.x | — | Superseded by `5.0.0` (same code, renumbered) |
| 0.1.x | 5 | `cordova-plugin-purchase` ^13.x | — | Superseded |

Capacitor 6 is not a separate target — Cap 5 → 7 is the supported upgrade path.

## Why Capacitor 5 shipped first

- The primary consumer app was on Capacitor 5 and blocked from publishing without IAP.
- The Cap 5 → 7 upgrade has many breaking changes orthogonal to IAP; bundling IAP into it would have gated the product launch.
- `cordova-plugin-purchase` was the only deferred-finish-capable plugin that worked on the Cap 5 bridge — MIT-licensed and production-tested.

The Capacitor 5 line stays on the `5.x` branch (as `5.x` releases, reachable via `^5` or the `@latest-5` dist-tag) and continues to receive patches for Capacitor 5 consumers. The Capacitor 7 line likewise lives on the `7.x` branch, reachable via `^7` or the `@latest-7` dist-tag. `main` is the `8.x` line, now current on `@latest`.

## Reporting issues with the upgrade path

File a GitHub issue with your Capacitor version, your `@capgo/native-purchases` (or `cordova-plugin-purchase`) version, and the failure mode. We'll prioritise compatibility shims for any consumer-visible breakage.

## See also

- [Installation](/guide/installation) — current version requirements
- [Architecture](/guide/architecture) — why the `NativeAdapter` boundary makes plugin swaps non-breaking
