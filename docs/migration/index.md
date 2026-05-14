# Migration

`@nosslabs/iap` has two lines, **each numbered to match the Capacitor major it targets**:

- **`7.x`** — **Capacitor 7+** (also runs on Capacitor 8), built on [`@capgo/native-purchases`](https://github.com/Cap-go/native-purchases). The current line, on `@latest`.
- **`5.x`** — **Capacitor 5**, built on `cordova-plugin-purchase`. In maintenance — pin `^5` to stay on this line; `^5` ranges do not resolve to `7.x`.

The public API surface (`createIAP`, the `IAP` interface, events, error codes, types) is the **same on both lines** — moving between them is a peer-dependency swap, not a code rewrite.

## 5.x (Capacitor 5) → 7.x (Capacitor 7+)

1. **Upgrade Capacitor** to 7 (or 8) per the [Capacitor migration guide](https://capacitorjs.com/docs/updating/7-0). This is usually the bulk of the work and is orthogonal to IAP.
2. **Swap the native plugin and bump `@nosslabs/iap`:**

   ```bash
   npm uninstall cordova-plugin-purchase
   npm install @nosslabs/iap @capgo/native-purchases
   # On Capacitor 8 you may instead pin: @capgo/native-purchases@^8
   ```
3. **Upgrade the Capacitor peer deps** you already have to v7+ (`@capacitor/core`, `@capacitor/preferences`, and the optional `@capacitor/app`).
4. **Run `npx cap sync`** so the new plugin's native source is linked.
5. **No changes to your `createIAP({ ... })` config or any consumer code.** Same `purchase()`/`restore()`/`refresh()`/`getEntitlements()` API, same events, same error codes, same return shapes.

The whole 0.2–0.4 feature set (carried forward into `5.0.0` and now `7.x`) is unchanged: the options-object `purchase()` signature, optional `appUserId` pre-attachment, the `INVALID_APP_USER_ID` / `APP_USER_ID_FETCH_FAILED` error codes, and the recovery behaviour (permanently-invalid entries are dropped rather than retried forever).

### Why a new plugin

`cordova-plugin-purchase` reaches the device through Capacitor's Cordova compatibility bridge, which is the path Capacitor is steadily de-emphasising. `@capgo/native-purchases` is a first-class Capacitor plugin (StoreKit 2 on iOS, Google Play Billing 7 on Android) and — crucially — supports `autoAcknowledgePurchases: false` on **both** platforms, so the library's "never grant before the backend confirms" guarantee holds with no iOS-specific finish-before-verify race. The plugin-version specifics are isolated behind the `NativeAdapter` interface (`src/adapters/native/capgo/native-adapter.ts`) — the same boundary that lets the library run on web via the web-stub adapter.

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
| 7.0.x | 7 (also 8) | `@capgo/native-purchases` 7.16.x (or `^8` on Cap 8) | `@latest` | **Current** |
| 5.0.x | 5 | `cordova-plugin-purchase` ^13.x | (pin via `^5`) | Maintenance |
| 0.2.x – 0.4.x | 5 | `cordova-plugin-purchase` ^13.x | — | Superseded by `5.0.0` (same code, renumbered) |
| 0.1.x | 5 | `cordova-plugin-purchase` ^13.x | — | Superseded |

Capacitor 6 is not a separate target — Cap 5 → 7 is the supported upgrade path.

## Why Capacitor 5 shipped first

- The primary consumer app was on Capacitor 5 and blocked from publishing without IAP.
- The Cap 5 → 7 upgrade has many breaking changes orthogonal to IAP; bundling IAP into it would have gated the product launch.
- `cordova-plugin-purchase` was the only deferred-finish-capable plugin that worked on the Cap 5 bridge — MIT-licensed and production-tested.

The Capacitor 5 line stays on the `5.x` branch (as `5.x` releases on `@latest`) and continues to receive patches for Capacitor 5 consumers. `main` is now the in-dev `7.x` line.

## Reporting issues with the upgrade path

File a GitHub issue with your Capacitor version, your `@capgo/native-purchases` (or `cordova-plugin-purchase`) version, and the failure mode. We'll prioritise compatibility shims for any consumer-visible breakage.

## See also

- [Installation](/guide/installation) — current version requirements
- [Architecture](/guide/architecture) — why the `NativeAdapter` boundary makes plugin swaps non-breaking
