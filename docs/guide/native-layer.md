# The native layer

`@nosslabs/iap` does not talk to StoreKit or Play Billing itself. It delegates every native
call to [`@capgo/native-purchases`](https://github.com/Cap-go/capacitor-native-purchases),
which you install alongside it as a peer dependency. This page records what that plugin is,
what it guarantees, and — just as usefully — what it does **not** expose, because that
boundary is what decides which iap features can exist.

Everything here was audited against **`@capgo/native-purchases@8.6.5`**, the release iap's
`8.x` line is developed and tested against.

::: tip Most of this page is tested
The structural claims below — the Play Billing floor, the licence, the absence of identifier
APIs, which plugin fields exist, and each gap in the last section — are asserted in
[`tests/unit/native-plugin-contract.test.ts`](https://github.com/nossdev/iap/blob/main/tests/unit/native-plugin-contract.test.ts),
which reads the *installed* plugin's own Gradle file, `LICENSE`, `package.json`, native
sources and type declarations. A plugin bump that invalidates one of them fails CI rather
than quietly making this page wrong.

The guards hold the **major** version lines (plugin `8.x`, Play Billing `8+`), so exact patch
numbers quoted in prose are free to move under them. Claims about *behaviour* rather than
surface — what the native code does with a value at runtime — are not asserted; they were
read out of the plugin's source at `8.6.5` and are the first thing to re-check on a major bump.
:::

## Play Billing Library version

The plugin builds against **Play Billing Library 8.x** (currently `8.3.0`, in
`android/build.gradle`).

Google requires new apps and app updates to ship Billing Library 8 or later. Google's own
pages disagree on the exact cut-off — the
[purchase-lifecycle](https://developer.android.com/google/play/billing/lifecycle) and
[getting-ready](https://developer.android.com/google/play/billing/getting-ready) pages state
**31 August 2026** with extensions to 1 November 2026, while the older
[version-deprecation FAQ](https://developer.android.com/google/play/billing/deprecation-faq)
table lists 31 August 2027. **Check the Play Console for your app's specific date**; it shows
a warning when an app uses an unsupported version.

Either way, iap is on the right side of it: nothing to upgrade, and the test above holds the
floor at major 8 so a downgrade can't slip past review.

## Licence

`@capgo/native-purchases` is **MPL-2.0**. iap itself is MIT.

MPL-2.0 is *file-level* copyleft, which makes the obligation easy to reason about:

- **Using the plugin unmodified** — as iap does, and as your app does by installing it from
  npm — imposes no licence obligation on your own source. You distribute the plugin's files
  under MPL-2.0, unchanged and with the package's `LICENSE` intact (its sources carry no
  per-file MPL headers, so the package-root licence is the notice), and your code stays under
  whatever licence you chose.
- **Modifying any of its files** — vendoring a patched copy into your repo, or forking it —
  makes those modified files MPL-2.0, and you must publish them in source form. The
  obligation attaches to the touched files, not to your whole app.

iap deliberately **does not vendor or patch** the plugin, so no MPL obligation propagates to
iap or to its consumers. If a future gap forces a vendored layer, that will be called out in
the CHANGELOG, because it changes this answer.

## Privacy: no device identifiers

iap collects no telemetry and reads no device identifiers. That claim only holds if the
native layer behaves the same way, so every native source the plugin ships was swept for
identifier APIs:

| Platform | Swept for | Found |
|---|---|---|
| Android | `AdvertisingIdClient`, `ANDROID_ID`, `Settings.Secure`, `getDeviceId`, `getImei`, `getSubscriberId` | none |
| iOS | `identifierForVendor`, `advertisingIdentifier`, `ASIdentifierManager`, `ATTrackingManager` | none |

The sweep discovers the plugin's source files rather than working from a fixed list, so a
file added in a later release is covered too.

The plugin also ships an **empty `AndroidManifest.xml`** — it declares no permissions of its
own, so merging it into your app cannot widen your app's permission set. (The
`com.android.vending.BILLING` permission comes from the billing library itself.)

The only user-scoped value that crosses the bridge is the one **you** supply: the
`appAccountToken` / `obfuscatedAccountId` binding passed to `iap.purchase({ appUserId })`.
iap never generates one of its own.

### One caveat: purchase tokens reach the device log

The audit above is about identifiers the plugin *collects*. There is one thing it *emits*
that is worth knowing: **the Android plugin writes purchase tokens to logcat in the clear**,
in several places, with no `BuildConfig.DEBUG` or `isLoggable` gate — for example
`Log.d(TAG, "Purchase token: " + purchase.getPurchaseToken())`. It does redact the account
identifier (logging `[REDACTED]` rather than the value), so this looks like an oversight
rather than a policy. iOS writes a smaller number of `print(...)` lines.

This matters because iap's own rule is never to log a raw token, JWS payload or auth header —
its internal logs mask them (`src/lib/redact.ts`). That rule stops at the bridge: a purchase
token is a receipt, and on Android it is readable by anything that can read the device log.
Treat it as a reason to keep release builds' log access locked down, not as a reason to avoid
the plugin. Closing it needs an upstream change.

## What the plugin exposes

The plugin's surface is wider than what iap currently surfaces. The distinction matters: the
third column is what iap does with each field **today**, not what it could.

| Plugin field | Platform | What iap does with it today |
|---|---|---|
| `transactionId` | both | The Apple transaction id on the normalized transaction. |
| `purchaseToken` | Android | The token on the normalized transaction. |
| `purchaseState` | Android | Filters `PENDING` purchases out of the owned set. |
| `orderId` | Android | Platform inference only. |
| `jwsRepresentation`, `receipt` | iOS | Platform inference only — iap does not parse either payload. |
| `appAccountToken` | both | Set on purchase from `appUserId`. Not yet read back off the transaction. |
| `price`, `priceString`, `currencyCode`, `title`, `description` | both | The `Product` shape returned by `getProducts()`. |
| `planIdentifier` | Android | Passed through from `androidPlanId` to select a base plan. |
| `introductoryPrice`, `discounts` | both | **Not surfaced.** Available for intro/promotional offers. |
| `offerToken`, `offerId` | Android | **Not surfaced.** Available for offer identification. |
| `subscriptionGroupIdentifier`, `pricingTerms` | iOS | **Not surfaced.** |
| `expirationDate`, `isActive`, `subscriptionState` | iOS | **Not surfaced** in typed form; reachable on `NativeTransaction.raw`. |
| `renewalInfo`, `willCancel` | iOS | **Not surfaced** in typed form; reachable on `NativeTransaction.raw`. |
| `addListener('transactionUpdated')` | **iOS only** | **Not wired.** See below. |

Fields marked *not surfaced* ride along untyped on `NativeTransaction.raw`, so nothing is
lost — a consumer can reach them today at the cost of casting.

### Out-of-band transaction updates are not wired

The plugin offers `transactionUpdated` (and a companion `transactionVerificationFailed`),
fed from Apple's `Transaction.updates` — **iOS only**; there is no Android equivalent in
8.6.5. iap does not subscribe to either. That was a deliberate choice, recorded in
`docs/internal/plugin-v7-api.md`: recovery replays from the `unfinished_transactions` store
at launch and `refreshOnResume` reconciles server-side renewals, so out-of-band changes are
picked up on the next launch or resume on **both** platforms rather than live on one.

The cost is latency, not correctness: a renewal, a refund, or an Android e-wallet purchase
that clears while the app is in the foreground surfaces at the next resume.

### iOS transactions are verified before they reach iap

Worth stating plainly, because it determines what an on-device check could ever mean on iOS:
the plugin resolves `purchaseProduct()` **only** for a StoreKit 2
`VerificationResult.verified` transaction. So by the time a transaction reaches iap, Apple's
signature check has already passed in native code — iap does not repeat it, and could not do
better in the WebView.

How an unverified transaction surfaces depends on the path, and it is easy to get wrong:

- **On purchase**, the native layer calls `reject` with StoreKit's error description. It
  arrives in the WebView as a rejected promise, which iap maps to a failed
  `PurchaseResult` — *not* as a `transactionVerificationFailed` event. That event is emitted
  only from the `Transaction.updates` listener, which iap does not subscribe to.
- **On restore / `getPurchases()`**, unverified entries are **silently skipped**. They
  simply do not appear in the owned set, with no error and no event.

So an unverified transaction is never mistaken for a good one, but it is also never
*reported* to iap as such — on restore it is indistinguishable from a purchase that was
never made.

## What the plugin does not expose

These are the gaps as of 8.6.5. Each one caps what iap could offer, and each is guarded by an
*inverted* test — when capgo adds one, CI fails, which is the signal to revisit this page.

| Gap | Consequence |
|---|---|
| **Play purchase signature and original JSON** (`getSignature()` / `getOriginalJson()` are read nowhere in the Android sources) | No cryptographic check against the app's licence key is possible on the device. Were one built, it could only cover purchase state, product match, and the binding — which is a claim about the store's say-so, not a signature. |
| **`originalTransactionId` as a field** | The stable iOS purchase reference — the one that survives renewals — is only reachable by decoding the `jwsRepresentation` payload. `transactionId` changes with each renewal. |
| **Intro-offer eligibility** (no `isEligibleForIntroOffer`, no eligibility query; the `INTRO_ELIGIBILITY_STATUS` enum is declared but unused) | Whether *this user* qualifies for an introductory offer cannot be known on the device. The offer's existence and terms can; the eligibility cannot. |
| **A caller-chosen offer token on `purchaseProduct()`** (it accepts `planIdentifier`, a base plan) | The plugin *does* pass an offer token to Play — it just picks one itself: the first offer whose base plan id matches, which may be a promotional offer. The caller cannot choose which offer within a base plan is purchased. |
| **An error when `planIdentifier` matches nothing** | The plugin falls back to the **first** available subscription offer. So a typo'd or stale `androidPlanId` does not fail — it silently purchases a different base plan. Keep `androidPlanId` in step with Play Console; there is no client-side signal when it drifts. |
| **Android purchase-update events** (`transactionUpdated` is fed from Apple's `Transaction.updates` only) | There is no live Android signal for a renewal, a refund, or a pending purchase clearing. |

If one of these blocks something you need, the fix belongs upstream in
`@capgo/native-purchases`, not in a patched copy here — see the licence note above.

## Version policy

iap's major tracks Capacitor's, and each line pins the plugin range that matches it. The
authoritative table is [Version compatibility](/migration/#version-compatibility); in short,
`8.x` pairs with `@capgo/native-purchases ^8`.

Plugin-version differences are absorbed in
[`src/adapters/native/`](https://github.com/nossdev/iap/tree/main/src/adapters/native), never
in the core flows — so a plugin bump touches one file. The equivalent surface capture for the
Capacitor 7 line is archived at `docs/internal/plugin-v7-api.md` in the repository.
