# The native layer

`@nosslabs/iap` does not talk to StoreKit or Play Billing itself. It delegates every native
call to [`@capgo/native-purchases`](https://github.com/Cap-go/capacitor-native-purchases),
which you install alongside it as a peer dependency. This page records what that plugin is,
what it guarantees, and — just as usefully — what it does **not** expose, because that
boundary is what decides which iap features can exist.

Everything here was audited against **`@capgo/native-purchases@8.9.6`**, the release iap's
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
read out of the plugin's source at `8.9.6` and are the first thing to re-check on a major bump.
:::

## Play Billing Library version

The plugin builds against **Play Billing Library 9.x** (currently `9.1.0`, in
`android/build.gradle`); the guard holds a floor of 8, not an exact version.

The 8 → 9 bump changed nothing iap depends on, and that was checked rather than assumed:
`Purchase.PurchaseState` still reads `UNSPECIFIED_STATE = 0, PURCHASED = 1, PENDING = 2` in the
9.1.0 artifact, and `consumeAsync`, `acknowledgePurchase` and `queryPurchasesAsync` keep their
signatures. Those three facts are what iap's Android purchase-state check and its consumable
path are built on.

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

### Purchase tokens in the device log: fixed upstream

Through `8.6.5` the Android plugin wrote **purchase tokens to logcat in the clear**, in several
places, with no `BuildConfig.DEBUG` or `isLoggable` gate. This page used to warn about it.

**capgo closed it in the `8.9.x` line.** Every Android log now goes through
`NativePurchasesLog`, gated on `BuildConfig.DEBUG` or an explicit `debugLogging` plugin
config, and the purchase summary it logs carries product ids, purchase state and the
acknowledged flag — no token. Verified rather than taken on trust: no `android.util.Log` call
survives outside the gated wrapper, which the contract test asserts, so a future release that
reintroduces one fails CI.

iOS still writes a smaller number of `print(...)` lines.

iap's own rule is unchanged and independent of this: never log a raw token, JWS payload or
auth header — its internal logs mask them (`src/lib/redact.ts`). Keeping release builds' log
access locked down is still good practice, but it is no longer compensating for the plugin.

## What the plugin exposes

The plugin's surface is wider than what iap currently surfaces. The distinction matters: the
third column is what iap does with each field **today**, not what it could.

| Plugin field | Platform | What iap does with it today |
|---|---|---|
| `transactionId` | both | `NativeTransaction.token` on iOS; the acknowledge handle. |
| `purchaseToken` | Android | `NativeTransaction.token` and `purchaseReference`. |
| `purchaseState` | Android | Filters `PENDING` purchases out of the owned set. |
| `orderId` | Android | Platform inference only. |
| `jwsRepresentation` | iOS | Decoded for its `originalTransactionId` claim → `NativeTransaction.purchaseReference`. **Data only — no signature check**; see below. |
| `receipt` | iOS | Platform inference only. |
| `appAccountToken` | both | Set on purchase from `appUserId`, and read back as `NativeTransaction.appUserId`. |
| `price`, `priceString`, `currencyCode`, `title`, `description` | both | The `Product` shape returned by `getProducts()`. |
| `planIdentifier` | Android | Two meanings, unfortunately. On `purchaseProduct()` it is the **base plan** to buy, passed through from `androidPlanId`. On a *product* payload it is the Play **product id** — which is how iap matches a payload back to a configured product, since `identifier` there is the base plan. |
| `introductoryPrice` | both | `Product.introductoryOffer`, normalized to `SubscriptionOffer`. |
| `discounts` | both | `Product.promotionalOffers`. |
| `offerToken`, `offerId` | Android | `Product.androidOfferToken` / `androidOfferId`. Identification only *through iap* — the plugin accepts an `offerToken` on `purchaseProduct()` since `8.9.x`, but `iap.purchase()` does not forward one yet. |
| `subscriptionPeriod` | iOS | `Product.subscriptionPeriod`, as an ISO 8601 duration. Absent on Android. |
| `subscriptionGroupIdentifier` | iOS | `Product.subscriptionGroupId`. |
| `expirationDate`, `subscriptionState` | iOS | `NativeTransaction.subscription.expiresAt` / `.state`. |
| `renewalInfo`, `willCancel` | iOS | `NativeTransaction.subscription.autoRenewing` / `.renewsAt` / `.renewalProductId`. |
| `isActive`, `ownershipType`, `environment`, transaction `commitmentInfo` | iOS | **Not surfaced** in typed form; reachable on `NativeTransaction.raw`. |
| `pricingTerms`, product `commitmentInfo` | iOS | **Not surfaced, and not reachable.** These are `Product` fields, and `Product` has no `raw` passthrough. |
| `addListener('transactionUpdated')` | **iOS only** | Subscribed from `initialize()`. Feeds `transaction-updated`, and settles the transaction through the recovery path. |
| `addListener('transactionVerificationFailed')` | **iOS only** | Subscribed, and logged. Its payload carries no product id, so there is no iap event it could populate honestly. |
| `purchaseState === '0'` | Android | Read to tell a pending purchase from a vanished one, which is what makes `purchase-pending-resolved` honest. |

Transaction fields marked *not surfaced* ride along untyped on `NativeTransaction.raw`, so
nothing is lost there — a consumer can reach them at the cost of casting. **`Product` has no
such passthrough**, so an unsurfaced product field is genuinely unavailable; the row above
that says so is the current gap.

::: warning Two legends not to trust
capgo's `paymentMode` integers are **not** `SKProductDiscount.PaymentMode`, despite its iOS
source saying so: it emits `freeTrial=0, payUpFront=1, payAsYouGo=2`, where Apple's documented
order is `payAsYouGo=0, payUpFront=1, freeTrial=2`. Both of capgo's platforms use capgo's
order, so iap maps from that — mapping from Apple's legend would report every free trial as
pay-as-you-go.

Separately, the plugin's TypeScript declares `subscriptionPeriod` and
`subscriptionGroupIdentifier` as **required** on `Product`, but its Android side sets neither.
Reading `product.subscriptionPeriod.unitString` typechecks clean and throws on a device. iap
narrows both to optional at the adapter boundary.
:::

### Out-of-band transaction updates: live on iOS, reconciled on Android

The plugin offers `transactionUpdated` and a companion
`transactionVerificationFailed`, fed from Apple's `Transaction.updates` — **iOS only**;
there is no Android equivalent in 8.9.6, where the native side notifies no listeners at
all. iap subscribes to both from `initialize()` and removes them in `destroy()`.

(Earlier versions deliberately did not, as `docs/internal/plugin-v7-api.md` records. The
reasoning there — that recovery at launch plus refresh on resume covers the same ground —
still holds for Android, and is exactly what Android now relies on.)

So the two platforms reach the same state by different routes:

| | iOS | Android |
|---|---|---|
| A renewal or refund | Pushed to the listener, settled immediately | Picked up at the next launch or resume |
| An Ask-to-Buy approval | Pushed to the listener | n/a |
| A pending purchase clearing | Pushed to the listener | Found by asking the store at launch/resume |
| A pending purchase *failing* | No signal exists — iap stays quiet, and drops the mark after 30 days | Detected via `purchaseState` (Play's `PENDING = 2`), reported as `cancelled` |

An arriving transaction goes through the **same path recovery uses** — persisted before
verification, left in the store to retry on failure. A second settlement path would be a
second place for those invariants to drift.

One invariant does **not** carry over, and it is worth being exact about: the plugin calls
`transaction.finish()` *before* it notifies listeners, so on this path the platform has
already finished the transaction by the time iap sees it. "Acknowledged only after the backend
confirms" describes the purchase flow, not this one — iap has no say in the ordering here.
That makes persisting first matter *more*, not less: StoreKit will not redeliver a finished
transaction, so iap's own record is the only remaining handle on it. It also means an
`acknowledge` that fails with "already finished" is treated as success on this path only, or a
pending purchase that in fact completed would never be reported.

::: tip Consumables are consumed, on every path
Play distinguishes acknowledging a purchase from **consuming** one, and a consumable must be
consumed before it can be bought again. iap consumes it — after verification, on all four
paths that settle a transaction: a purchase, a restore, launch recovery, and a transaction
arriving on its own. So a consumable that clears out of band (the common shape for cash and
e-wallet payments) can be rebought like any other.

Two things make that work, and both are worth knowing if you write your own adapter:

- The product type comes from **your configured catalog**, not from the plugin's payload.
  Play reports a consumable and a one-time purchase both as `'inapp'`, so a store-reported
  transaction cannot be typed from what the store said.
- iap never passes the plugin's `isConsumable` flag. The plugin consumes on that flag inside
  the purchase callback **regardless of `autoAcknowledgePurchases`** — its
  `PurchaseActionDecider` reads the flag only on the acknowledge branch — which would finalise
  the purchase before iap verified it. That is unrecoverable rather than retryable: Billing 8.x
  drops a consumed purchase from `getPurchases()` entirely. A test guards the gap, so if capgo
  closes it iap can stop working around it.

A custom `NativeAdapter` with no `consume()` falls back to acknowledging, which still protects
the refund window — but the product stays owned, and iap logs a warning saying so.

iOS needs none of this: `Transaction.finish()` ends a consumable's lifecycle, and the plugin
rejects `consumePurchase()` there.
:::

A transaction that arrives while `purchase()` is handling the same product is ignored here:
StoreKit delivers it to both, and the flow that started it owns it. Settling twice would
verify twice, acknowledge twice, and emit a spurious `entitlements-changed`.

### iap decodes the JWS for data, and checks no signature

`NativeTransaction.purchaseReference` — surfaced to consumers as
[`StorePurchase.purchaseReference`](/api/types#storepurchase) — needs Apple's
`originalTransactionId`, which the plugin does not expose as a field. iap reads it out of
the `jwsRepresentation` payload: base64url-decode the middle segment, parse the JSON, take
the claim. **No signature is verified.**

That is sound here, and only here, because of the paragraph below: the value arrives having
already been signature-checked in native code, so the claims are trustworthy by provenance
rather than because iap checked them. The same function pointed at a JWS from anywhere else
— one received over the network, say — would be a security hole, which is why
`src/lib/jws.ts` says so at length, and why the backend path exists for everything that has
to be trusted rather than merely read.

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

These are the gaps as of 8.9.6. Each one caps what iap could offer, and each is guarded by an
*inverted* test — when capgo adds one, CI fails, which is the signal to revisit this page.

That mechanism has now earned its keep twice: the `8.6.5` → `8.9.6` bump failed exactly two
guards, and both were capgo closing a gap — the logcat tokens above, and the offer token in
the table below.

| Gap | Consequence |
|---|---|
| **Play purchase signature and original JSON** (`getSignature()` / `getOriginalJson()` are read nowhere in the Android sources) | No cryptographic check against the app's licence key is possible on the device. Were one built, it could only cover purchase state, product match, and the binding — which is a claim about the store's say-so, not a signature. |
| **`originalTransactionId` as a field** | The stable iOS purchase reference — the one that survives renewals — is only reachable by decoding the `jwsRepresentation` payload. `transactionId` changes with each renewal. |
| **Intro-offer eligibility** (no `isEligibleForIntroOffer`, no eligibility query; the `INTRO_ELIGIBILITY_STATUS` enum is declared but unused) | Whether *this user* qualifies for an introductory offer cannot be known on the device. The offer's existence and terms can; the eligibility cannot. |
| ~~**A caller-chosen offer token on `purchaseProduct()`**~~ — **available since plugin `8.9.x`** | The plugin now accepts `offerToken`, so choosing a specific offer within a base plan is possible at the native layer. **iap does not pass it yet**: `purchase()` has no way to name an offer, so buying a particular promotional or win-back offer is still out of reach through iap, even though `Product.androidOfferToken` already surfaces the tokens. A feature to build, not a gap to live with. |
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
