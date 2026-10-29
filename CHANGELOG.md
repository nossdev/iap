# Changelog

All notable changes to `@nosslabs/iap` will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`Product.introductoryOfferEligible`** — whether *this store account* can take the
  product's introductory offer. `true`/`false` on iOS, from StoreKit's
  `isEligibleForIntroOffer` by way of capgo's `introEligibility` (added in capgo 8.8.3);
  `null` on Android, and `null` on iOS when the product has no introductory offer or StoreKit
  did not answer.

  This closes a gap iap's own docs called permanent: `introductoryOffer` said eligibility
  "cannot be known on the device", which was true of capgo before 8.8.3 and has since not
  been. A paywall could only write copy that read correctly either way — "free for new
  subscribers" — and an account that had already used its trial was still shown the offer.

  Three things worth knowing before using it. StoreKit answers per **subscription group**, not
  per product, so every product sharing a `subscriptionGroupId` reports the same value: taking
  any introductory offer in a group spends it for all of them. `null` is "unknown" and never
  "ineligible" — mapping Android's unconditional `0` to `false` would hide an offer the account
  can take. And it is a **snapshot** from when `getProducts()` ran: a refund or a purchase on
  another device changes the answer, and the store's purchase sheet still applies eligibility
  itself at purchase time.

  Three contract tests pin what this rests on, since the mapping hardcodes capgo's enum
  numbering rather than importing the enum: that the numbers are still 0/1/2, that the field is
  still declared, and that the iOS source still fills it *through the payload `getProducts()`
  actually returns* — this plugin has shipped a declared-but-unread option before.

### Fixed

- **Corrected what omitting `androidOfferToken` actually does.** 8.3.0's own note above says
  "the native layer takes the first unless told which". That is wrong for the case a caller is
  most likely to hit, and the claim came from reading the plugin's TypeScript rather than its
  Java.

  The plugin sets the first offer in the list **only** when the product has no
  backward-compatible purchase option. While it has one — Play treats the offer *created* first
  in Play Console as that — `setOfferToken` is never called at all and Play applies that offer
  itself. So the default lands on creation order in Play Console, not on the order
  `getProducts()` returned, and a consumer who believed the first entry of
  `Product.androidOneTimeOffers` was the default could display one price while the store charged
  another. The same correction was accepted upstream in
  [Cap-go/capacitor-native-purchases#242](https://github.com/Cap-go/capacitor-native-purchases/pull/242).

  `PurchaseOptions.androidOfferToken` and the native-layer guide now state both branches and say
  to pass the token whenever the offer matters. A contract test pins the behaviour, so when capgo
  starts setting a token unconditionally, CI says so instead of the docs quietly going stale
  again.

## [8.3.0] — 2026-10-27

### Added

- **`purchase({ androidOfferToken })`** — buy a *specific* Android one-time purchase offer
  instead of letting the store pick. Play allows several offers on one one-time product (a base
  price plus, say, a launch discount) and the native layer takes the first unless told which.

- **`Product.androidOneTimeOffers`** — and this is what makes the option usable. Play reports
  **one payload per one-time offer**, each with its own price and token; iap returns one
  `Product` per configured id and prices it from the base offer, which discarded every
  discounted token. So the only token a consumer could obtain selected the *full price* —
  passing it would have pinned $4.99 where the store's own default might have charged $2.49.
  Every offer the store returned is now reported, with its `offerId`, `offerToken`,
  `priceString`, `price` and `currencyCode`. Absent for a single-offer product, on iOS, and for
  subscriptions, whose offers cannot be selected at purchase time at all.

  The tokens are **per-query device tokens**: read them from the same `getProducts()` call you
  purchase from. A persisted one is rejected by the store, which iap now reports as
  `INVALID_PURCHASE_OPTIONS` instead of a generic `STORE_ERROR` telling you to check device
  connectivity.

- **`IAPErrorCode.INVALID_PURCHASE_OPTIONS`** — an argument to `purchase()` is unusable, as
  distinct from `INVALID_CONFIG`, which is `createIAP()` schema validation. Raised for an
  `androidOfferToken` that is empty, that is given for a subscription, or that matches no
  current offer.

  An **empty** token is refused rather than dropped, because it is what a defensive
  `token ?? ''` produces when the catalog moved under the UI — and dropping it would charge
  whichever offer the store picked while the app displayed another, which is the whole harm
  this feature guards against. `null` behaves as if omitted, since `Product.androidOfferToken`
  is `string | null` and `null` there genuinely means "no specific offer".

### Fixed

- **Corrected an iap `8.2.0` claim: a subscription's offer still cannot be chosen.** That
  release reported capgo's new `purchaseProduct({ offerToken })` as "choosing a specific offer
  within a base plan is now possible at the native layer". Reading the plugin's Java rather
  than its type declaration shows otherwise: the subscription path matches `planIdentifier`
  against the base plan id, falls back to the **first** offer, and calls `setOfferToken` with
  the offer *it* chose. The caller's token is never read there. Only the one-time-purchase path
  honours it — and there it validates, rejecting an unknown token rather than falling back.
  iOS reads no offer token at all.

  So `purchase()` **refuses** `androidOfferToken` for a subscription rather than forwarding it
  to be dropped: forwarding would let a consumer believe they had bought a chosen promotional
  offer while the store charged a different one's price. `androidPlanId` remains the only
  subscription-offer control.

  The guard that produced the wrong claim checked the plugin's *declaration*. It now reads the
  Java, asserts the caller's token is not referenced anywhere in the subscription branch, and
  was verified against a patched plugin source — including the idioms an identifier-keyed check
  would have missed. When capgo closes that gap, the guard fails and the refusal can become a
  forward. Same lesson as three previous findings in this plugin: its types and comments
  describe intent, its code describes behaviour.

- **`purchase()` throws `PRODUCT_NOT_FOUND`, not `INVALID_CONFIG`, for an unconfigured
  product id**, which is what the code has always done — the error-handling guide said
  otherwise. That guide also said `INVALID_CONFIG` "never reaches `initialize()`"; since
  `8.2.0` it can, for a lazily-resolved `@capacitor/preferences`. Both corrected.

## [8.2.0] — 2026-10-27

### Changed

- **`@capacitor/preferences` is now an optional peer, loaded only when it is used.** It was a
  required peer reached through a *static* import, so it ended up in the bundle's top-level
  imports and every consumer shipped the native plugin — including one passing
  `storage.type: 'custom'` with its own storage, which never calls Preferences at all.

  `PreferencesAdapter` now reaches the plugin through `await import()`, memoised per instance,
  the way the resume listener reaches `@capacitor/app`. Neither `dist/index.js` nor
  `dist/index.cjs` names it at the top level any more, asserted on the built artifact by a new
  `npm run verify:bundle` step in CI and before publish — a static import behaves identically
  at runtime and differs only in what the bundler hoists, so no unit test can see it.

  Choosing `storage.type: 'preferences'` (still the default) without the plugin installed now
  fails at `initialize()` with `INVALID_CONFIG`, naming what to install and the two
  alternatives that need no plugin. It is reported there, via the new optional
  `StorageAdapter.ensureAvailable()`, rather than at the first cache read: that read treats any
  failure as "nothing cached", so a missing plugin would have looked like a cold start while
  iap silently persisted nothing.

  **If you use `storage.type: 'preferences'`, keep the plugin installed** — but check it is in
  your *own* `dependencies`. npm 7+ installs a required peer into the tree without listing it
  in your `package.json`; now that it is optional, a fresh install or a regenerated lockfile
  can drop it, and `npx cap sync` with it.

  If you pass your own adapter or use `'memory'`, you can uninstall it — and then you must
  **externalise it in your bundler**, because a dynamic `import()` is still resolved at build
  time: without it Vite/Rollup fails with `failed to resolve import "@capacitor/preferences"`.
  The installation guide has the one-line config. (This is not new to this release — the
  optional `@capacitor/app` has always behaved the same way — but it is now worth stating.)

- **Developed and tested against `@capgo/native-purchases@8.9.6`** (was `8.6.5`). The peer
  range is unchanged at `^8.2.0`. Nothing in iap broke, and two of the plugin's documented
  gaps closed — both caught by the inverted contract guards rather than by reading release
  notes:

  - **Purchase tokens no longer reach logcat.** Through `8.6.5` the Android plugin logged them
    in the clear with no debug gate, which [the native-layer
    page](https://iap.nossdev.com/guide/native-layer) warned about. Every Android log now goes
    through a `NativePurchasesLog` wrapper gated on `BuildConfig.DEBUG` or an explicit
    `debugLogging` config, and the purchase summary it emits carries no token. Verified by
    asserting that no `android.util.Log` call survives outside the wrapper, so a regression
    fails CI; the warning is off the page.
  - **`purchaseProduct()` accepts an `offerToken`.** This note overstated what that means.
    The plugin reads the token **only on its one-time-purchase path**, never for a
    subscription — see the iap `8.3.0` entry above, which corrects it.

  The plugin also moved to **Play Billing Library 9.1.0** (from Play Billing 8.3.0 — not to be confused with iap's own 8.3.0 above), a native major. It
  changes nothing iap relies on, and that was checked against the 9.1.0 artifact rather than
  assumed: `Purchase.PurchaseState` still reads `UNSPECIFIED_STATE = 0, PURCHASED = 1,
  PENDING = 2`, and `consumeAsync`, `acknowledgePurchase` and `queryPurchasesAsync` keep their
  signatures — the three facts the Android purchase-state check and the consumable path are
  built on.

## [8.1.0] — 2026-10-27

### Changed

- **`peerDependencies` now require `@capgo/native-purchases` `^8.2.0`**, up from `^8.0.0`.
  `consumePurchase()` landed in 8.2.0, and the consumable path above needs it: on 8.0.x/8.1.x
  the call would reject at the bridge and be retried forever rather than degrading.

### Added

- **Local verification — iap works with no backend at all.** `verification: { mode: 'local',
  entitlements }` replaces the `backend` block and verifies purchases on the device. Exactly
  one of the two is required; both is a config error.

  Implemented as a `BackendAdapter`, which is the whole design: everything above that boundary
  is **untouched**. The purchase flow, the acknowledge-only-after-verification ordering, the
  at-least-once write before verifying, and the unfinished-transaction recovery all behave
  identically and do not know which mode they are in. There is no second purchase path to keep
  in step, and a purchase whose local check fails is never acknowledged — so the store keeps it
  and recovery retries, which on Android is what prevents the 3-day auto-refund.

  `refresh()` and `restorePurchases()` both ask the store what it owns, so they keep working
  with no network.

  **Be clear about the strength.** Every verified purchase carries an `assurance`:
  `store-signed` on iOS, where StoreKit verified Apple's signature in native code before the
  transaction reached the WebView, and `store-reported` on Android, where **no cryptographic
  check is possible** — the native layer exposes neither Play's purchase signature nor the JSON
  it is computed over, so the answer is the store's word. Neither resists a lying device.
  Local mode is for an app whose alternative is no verification at all; it is not a substitute
  for a server where being wrong is expensive.

  The checks are exported as `verifyPurchaseOnDevice` for consumers who would rather write
  their own adapter around them.

- **Offline semantics, written down as guarantees** — [Offline and no-backend
  use](https://iap.nossdev.com/guide/offline-and-no-backend). Most of this was already the
  behaviour; it was never stated, so it could not be relied on.

- **`options.entitlementGraceMs`** — extra time past `expiresAt` during which an entitlement
  still counts. Defaults to `0`. Set it because a renewal is not instantaneous: a subscription
  renewing at midnight may not have a fresh receipt for hours, and locking a paying user out in
  that window is the worse error. On Android store-side grace and billing retry are
  server-side only, so a backendless app cannot see them and this is its only cushion.

- **`iap.getEntitlementsVerifiedAt()`** — when the entitlements were last confirmed, ISO 8601
  or `null`. iap deliberately does not revoke on staleness, so this is for an app that wants to
  be stricter than iap is.

- **`iap.reset()`** — erase the entitlement cache, the unfinished-transaction queue and the
  pending-purchase marks. For a "delete everything" control. Not `destroy()`, which keeps the
  cache so the next instance reads it immediately; and not a revocation — the store still owns
  the purchase, and a restore brings the entitlement back, which is correct because the user
  paid.

  Every key comes from one registry, so a store added in a later version cannot quietly survive
  a wipe, and each is removed **by name** as well as through its store — the Preferences adapter
  can only clear keys it has seen this session, so clearing the namespace alone is a no-op on a
  fresh launch.

  It throws `ALREADY_IN_PROGRESS` (as `recoverable`) while a `purchase()` is in flight: that
  purchase's unfinished-transaction record is written before verification precisely so it
  survives a crash, and deleting it mid-flight would leave a purchase neither acknowledged nor
  tracked — which Google auto-refunds after three days. Await the purchase, then reset. After
  `destroy()` it still wipes and does not throw; that is the safest moment, since no
  orchestrator is left to re-persist.

- **`verification.appUserId` accepts a getter**, `string | (() => string | null)`, read at the
  time of each check so the binding follows the session. A fixed string is captured at
  `createIAP()` time, so in a multi-user app it is the previous user's after a login change and
  every purchase made afterwards is refused as a mismatch, with no recovery short of rebuilding
  the instance.

  A getter returning `null` means "nobody is signed in", which is **not** the same as using no
  binding: purchases and restores are refused (`BINDING_UNAVAILABLE`) rather than falling back
  to an unguarded check, since the alternative is accepting a purchase bound to someone else. A
  refresh in that state keeps the current entitlements instead of revoking them — a multi-user
  app restores its session asynchronously, and "I cannot tell you" must never read as "you own
  nothing".

- **Android consumables are consumed, not just acknowledged, so they can be bought again.**
  Play treats acknowledging and consuming as different things, and only consuming releases
  ownership. A consumable that cleared out of band — a restore, or launch recovery — was
  acknowledged and then stayed owned forever, so `purchase()` of it failed `ALREADY_PURCHASED`
  permanently. With a backend the entitlement was unaffected and only the product was
  unbuyable; in local mode a mapper that granted something for a consumable kept granting it
  on every refresh, since the purchase never left the store's owned set.

  Three parts. `NativeAdapter` gains an optional **`consume(transaction)`** (capgo's
  `consumePurchase()`); a custom adapter without it falls back to acknowledging and logs that
  the product will stay owned. All four settle paths now go through one `finalizeTransaction`
  step that decides acknowledge-vs-consume. And a store-reported transaction is typed from
  **your configured catalog**, because Play reports a consumable and a one-time purchase both
  as `'inapp'` — the plugin's payload cannot tell them apart. The catalog only *refines* the
  store's answer: it can turn `'inapp'` into `'consumable'`, and never contradicts a `'subs'`,
  so one wrong `type` in a config or a stale `backend.listProducts()` manifest cannot strip a
  subscription's expiry and have it granted forever.

  iap also no longer passes the plugin's `isConsumable` flag. The plugin consumes on that flag
  inside the purchase callback **regardless of `autoAcknowledgePurchases`**, which contradicts
  that option's own documentation and would have finalised a purchase before iap verified it —
  unrecoverably, since Billing 8.x drops a consumed purchase from `getPurchases()`. Found by
  reading the plugin's Java rather than its docs, and now guarded by a test so that if capgo
  closes the gap iap can stop working around it.

  Two things to know if you sell consumables. A consumed purchase leaves `getPurchases()` for
  good in Billing 8, so **in local mode an entitlement derived from a consumable now
  disappears at the next refresh** — which is what `LocallyVerifiedPurchase.productType` has
  always warned about, but it used to be masked. Keep a consumable's effect in your own
  records, not in a standing entitlement. And `restorePurchases()` now clears a pending mark
  it settles, which it never did: harmless while a purchase stayed owned for the next
  reconcile to find, but a consumed one is gone, and the reconcile would otherwise have
  reported a succeeded purchase as `cancelled`.

- **`LocalVerificationError` gains `BINDING_UNAVAILABLE`.** Additive, but it widens a public
  union, so an exhaustive `switch` over it will need the new arm.

- **`BackendAdapter.verifyNative`**, optional. An adapter that can answer from the whole
  transaction gets it whole, rather than the extracted `{ productId, token, type }` the HTTP
  contract sends — an on-device check needs the binding, the subscription state and the expiry,
  none of which survive that extraction. The HTTP adapter does not implement it, so nothing
  about what goes over the wire changes.

### Changed

- **In local mode, `hasEntitlement()`, `getEntitlement()` and `getEntitlements()` return only
  *active* entitlements** — ones whose `expiresAt` has not passed by the device clock, plus any
  `entitlementGraceMs`. With no backend to re-ask, the deadline is the only thing that can
  revoke anything, so enforcing it locally is the point.

  **With a backend they do not filter**, deliberately: the backend is the authority on what is
  granted, and it may return an entitlement whose `expiresAt` has passed on purpose — that is
  what a store-side grace period or billing retry looks like. Second-guessing it against the
  device clock would have iap perform a downgrade the backend did not ask for, and a device
  with a fast clock would lock out a paying user even with the backend reachable. So this is
  **not** a behaviour change for existing backend-mode consumers.

  In neither mode is an entitlement dropped because a refresh failed or the cache is old.

- **`backend` is now optional in `IAPConfig`**, since `verification` can take its place. Code
  that reads `config.backend` needs a null check; code that passes one is unaffected.

- **Introductory and promotional offers on `getProducts()`.** Each subscription now carries
  `introductoryOffer` and `promotionalOffers` as typed `SubscriptionOffer`s — offer type,
  payment mode (`free-trial` / `pay-up-front` / `pay-as-you-go`), the store's own localized
  price string plus micros, the period as an ISO 8601 duration, and the cycle count. Build
  paywall copy from these rather than hardcoding a price. `subscriptionPeriod`,
  `subscriptionGroupId`, `androidOfferToken` and `androidOfferId` come along too.

  **Eligibility is not among them, and cannot be.** The native layer exposes no eligibility
  query on either platform, so an offer being present means "this product has one", not
  "this user will get it" — the store's purchase sheet decides at purchase time. Write copy
  that reads correctly either way, or confirm server-side.

- **Transactions that happen outside a purchase now reach the consumer.** iap subscribes to
  Apple's `Transaction.updates` from `initialize()`, so a renewal, a refund or revocation, an
  Ask-to-Buy approval, or a pending purchase clearing is verified, acknowledged and reflected
  in entitlements while the app is running — previously none of that surfaced until the next
  launch. Two new events: `transaction-updated` (the store says something happened, before
  verification) and the authoritative `entitlements-changed` that follows.

  **iOS only, because that is the only feed that exists**: the native layer has no Android
  equivalent. On Android the same ground is covered by reconciliation at launch and on resume,
  which is what the previous behaviour already relied on for both platforms.

  An arriving transaction goes through the same path recovery uses — persisted before
  verification, acknowledged only after the backend confirms — rather than a second settlement
  path that could drift from it. One that arrives while `purchase()` is handling the same
  product is left to the purchase flow, since StoreKit delivers it to both and settling twice
  would verify twice, acknowledge twice and emit a spurious change.

- **`purchase-pending-resolved` — pending purchases now close out.** `purchase-pending` had no
  counterpart, so a paywall that put up "waiting for payment" had nothing to take it back down
  with. The new event reports `purchased` (cleared, and the entitlement is already in place) or
  `cancelled`, at most once per pending purchase.

  Pending purchases are remembered across launches, because that is when they resolve — a Play
  e-wallet payment can take hours with the app closed. The mark is checked at `initialize()`
  and on every resume, so the event can arrive in a much later session than the purchase.

  **`cancelled` is Android-only, deliberately.** It fires only where the platform can tell
  "gone" from "still waiting" — Play's purchase state. On iOS a deferred purchase that is never
  approved produces no signal at all, so iap says nothing rather than guessing and clearing a
  paywall's pending copy while a parent is still deciding. A mark iap cannot resolve is dropped
  after 30 days, silently and with no event: by then it is iap's unanswered question rather
  than a purchase in progress, and keeping it would make every foreground re-query the store
  for the life of the install.

  Known limitation, documented rather than half-fixed: a **consumable** that clears out of band
  is acknowledged but not *consumed*, so Play keeps reporting it owned and it cannot be
  rebought. Entitlement is unaffected. Closing it needs a consume path in the native adapter.

- **`appUserId` accepts any RFC 9562 UUID, not only v4.** A deterministic identifier is often
  the better choice: a UUIDv5 over a stable name gives the same binding on every device with
  nothing to persist or keep in step, and v7 is the current recommendation for time-ordered
  ids. Restricting to v4 forced consumers who already had a deterministic identity to mint a
  second one.

  Still refused: anything that is not a canonical UUID, non-RFC variant nibbles (which Apple
  rejects anyway), and the nil and max UUIDs — both are valid RFC 9562 constructs that
  deliberately carry no identity, so accepting one would bind a purchase to nothing while
  looking well-formed.

- **`StorePurchase`, on `purchase()` and `restorePurchases()` — the store's own view of a
  purchase.** `result.purchase` on a successful purchase, and `result.purchases` on a restore.
  It carries `purchaseReference`, `appUserId` and `subscription`, which is what makes the
  three fields below reachable: `purchase()` hands back a `VerifiedTransaction` (your
  backend's view of the receipt) and `NativeTransaction` is internal, so without this the
  normalized fields would have been computed and never readable by anyone.

  `restorePurchases()` is the route that matters for a reference you need *later*: after a
  reinstall or on a new device, the install that made the purchase is gone and cannot have
  kept it.

- **`NativeTransaction.purchaseReference` — the reference that survives renewals.** `token`
  is the handle for acknowledging *this* transaction, and on Apple it is a different value
  after every renewal; `purchaseReference` is the identity of the purchase itself, so it is
  what to store to recognise a subscription later. Google's `purchaseToken` already is one.
  Apple's `originalTransactionId` is not exposed as a plugin field, so iap reads it from the
  signed `jwsRepresentation` payload — **for its data, with no signature check**, which is
  sound only because the native layer resolves a purchase solely for an already-verified
  StoreKit 2 result. It falls back to `token` when the JWS is absent or unreadable, so it is
  always set, and a malformed JWS can never fail a purchase.

  It is persisted with the unfinished-transaction entry so recovery keeps it across launches.
  Entries written before this release carry only a token and still load, falling back to it.

- **`NativeTransaction.subscription` — typed renewal detail.** `state` (including
  `in-grace-period` and `in-billing-retry`), `autoRenewing`, `renewsAt`, `renewalProductId`
  and `expiresAt`, previously reachable only untyped on `raw`. iap passes these through and
  does not interpret them — no subscription state machine (PLAN.md §14).

  `null` on Android, where the plugin exposes no state, no renewal date and no auto-renew
  flag: a renewal object full of nulls would be worse than none, and `null` correctly says
  "ask the server".

- **`NativeTransaction.appUserId`** — the binding a purchase was made with, read back off the
  transaction (`appAccountToken` / `obfuscatedAccountId`), so a consumer can check what a
  purchase is bound to.

- **`Product.androidBasePlanId`** — the base plan an Android entry describes, reported
  separately now that `Product.id` is always the product id you configured. `null` on iOS.

- New exported types: `StorePurchase`, `SubscriptionOffer`, `SubscriptionOfferType`,
  `SubscriptionOfferPayment`, `SubscriptionRenewal`, `SubscriptionState`.

### Fixed

- **Free trials were going to be reported as pay-as-you-go.** `@capgo/native-purchases`
  labels its `paymentMode` integers "SKProductDiscount.PaymentMode-compatible: freeTrial=0,
  payUpFront=1, payAsYouGo=2", but Apple's actual order is payAsYouGo=0, payUpFront=1,
  freeTrial=2 — the comment is wrong about Apple, and both of capgo's platforms use capgo's
  own order. iap maps from the emitted values, with a test pinning the legend so nobody
  "corrects" it to Apple's — and, because a unit test can only pin iap against iap's own
  mocks, a second guard reads capgo's shipped Swift and Java so a change *there* fails CI too.
  Caught before shipping; no released version was affected.

- **Android subscriptions were reported as one-time products, under the wrong id.** capgo sets
  a product payload's `identifier` to the **base plan** id and `planIdentifier` to the Play
  **product** id, while iap queries by product id — so the type lookup missed on every Android
  subscription, fell through to `'product'`, and returned a `Product` whose `id` was a base
  plan the consumer never configured. `getProducts().find(p => p.id === configuredId)` could
  not match it. `Product.id` and `type` are now always what you configured, with the base plan
  reported as `androidBasePlanId`.

  Relatedly, capgo emits **one payload per offer** on a base plan, and only the base-plan entry
  carries the offers — so `getProducts()` could return several products sharing one id, most
  with no offers. Those are now collapsed to one per configured product, preferring the base
  plan named by `androidPlanId` and the entry that actually has the offers. A payload matching
  no configured product is dropped rather than mistyped.

- **One unreadable entry in the unfinished-transaction store wiped the whole list.** Entries
  were validated as a single array, so one malformed record failed the parse and cleared every
  pending recovery with it — abandoning purchases that were paid for and never acknowledged,
  which on Android Google refunds after three days. Entries are now validated individually:
  the bad one is dropped and logged, its neighbours survive.

- **`appUserId` never compared equal to what was passed in, on iOS.** StoreKit returns
  `UUID.uuidString`, which Swift renders uppercase, while `crypto.randomUUID()` and iap's
  case-insensitive validator both deal in lowercase. The binding is now lower-cased, so
  `purchase.appUserId === suppliedAppUserId` holds — the one comparison the field exists for.

- **Two lookup tables resolved inherited object properties.** `subscriptionState` and a
  subscription period's `unitString` arrive as strings off a native bridge and were looked up
  in plain object literals, so a value of `"constructor"` returned a function rather than
  missing: `state` could be a function at runtime while typed as a string union, and a period
  could render as `"P1function Object() { [native code] }"`. Both are `Map`s now. Not
  reachable from the store's own enums — but both functions are documented as total, and were
  not.

- **A price the store did not send became the string `"NaN"`.** `priceMicros` is `"0"` for a
  non-finite price now; `priceString` remains the value to display.

- **The installation guide said `@capgo/native-purchases` is MIT-licensed. It is MPL-2.0.**
  Corrected on both the `8.x` and the archived `v7` installation pages, which were the first
  place a consumer would have read it. iap uses the plugin unmodified, so the correction
  changes no obligation — but the stated licence is now the actual one. The stale
  `Cap-go/native-purchases` repository links were refreshed to
  `Cap-go/capacitor-native-purchases` on the same lines.

- **The configuration guide told you to do something that throws.** It said to register one
  Play subscription product's several base plans as separate `ConfiguredProduct` entries
  "with the same `id`" — which `createIAP()` rejects with `INVALID_CONFIG: Duplicate product
  id`. It now describes what actually works: one Play product per cadence, or one entry
  addressing one base plan via `androidPlanId`.

- **Documented Android limitations that were silently wrong rather than absent.**
  `promotionalOffers` on Android reports the base plan's *standard recurring* price, not the
  promotion's — so a free-trial promo arrives as `pay-as-you-go` at full price, and the docs
  now say not to render those terms there. `periodCount` is usually `0` on Android for any
  offer, because Play reports `getBillingCycleCount()` as `0` for both non-recurring and
  infinitely recurring phases. A period is single-component on Android (`P1M15D` → `P1M`).

- **The installation guide said `@capgo/native-purchases` is MIT-licensed. It is MPL-2.0.**
  Corrected on both the `8.x` and the archived `v7` installation pages, which were the first
  place a consumer would have read it. iap uses the plugin unmodified, so the correction
  changes no obligation — but the stated licence is now the actual one. The stale
  `Cap-go/native-purchases` repository links were refreshed to
  `Cap-go/capacitor-native-purchases` on the same lines.

### Fixed

- **Android purchases could never verify, and `restorePurchases()` always threw.** Google's
  verification APIs are keyed on the app's package name, and the native layer does not report
  it — so `verifyNativeTransaction` and the restore request builder both threw `STORE_ERROR`
  for *every* Google transaction. Every Android purchase returned `verification_failed` and
  every restore rejected.

  This predates this release and shipped: it was never caught because every Google test
  fixture hand-set the `packageName` field the real adapter never sets. Set
  `config.android.packageName` to your applicationId; `initialize()` warns on Android when it
  is missing, and the error messages now name the setting.

- **A purchase whose acknowledgement failed stopped being tracked.** `purchase()` removed the
  unfinished-transaction entry even when `acknowledge()` threw, on the reasoning that "a later
  restore()/refresh() re-acks it" — but only `restore()` acknowledges, and nothing calls it
  automatically. So a paid-for purchase was granted, left unacknowledged, and forgotten, right
  up to Google's silent 3-day auto-refund. The entry is now retained for recovery to retry.

- **Android would have reported every pending purchase as `cancelled` while it was still
  processing.** The pending-state check looked for Play `purchaseState === '0'`, following the
  plugin's own type declarations, which document `"0": Payment pending`. That is wrong: Play's
  `Purchase.PurchaseState` is `UNSPECIFIED_STATE = 0, PURCHASED = 1, PENDING = 2`, and
  `getPurchaseState()` only ever returns 1 or 2 — so the filter matched nothing and every
  tracked pending purchase read as vanished. Worse, the marker was then cleared, so when the
  payment really cleared the `purchased` event never fired either.

  Now expressed as "the store has it but does not call it owned", so `UNSPECIFIED_STATE` and
  any state Play adds later also read as not-yet-granted. Erring towards "still pending"
  self-corrects on the next pass; erring towards "cancelled" is permanent. A contract test
  pins that the plugin still passes Play's own integer through rather than translating it.

- **`purchase-pending-resolved` could fire twice, with two verifies and two acknowledges.**
  The resolution did a read-then-write across an `await`, and reconciliation had no
  re-entrancy guard — and both overlaps are reachable: the transaction listener is
  fire-and-forget, and the resume listener does not debounce, so two foreground events ran two
  reconciliations. On Android the second acknowledge of an already-acked token errors, which
  the settle path reads as a failure and retains the entry for. Now a single atomic
  take-if-present, a single-flight reconciliation, and a per-token settle guard.

- **A pending purchase settled by any other path was later reported `cancelled`.** Only the
  update orchestrator cleared the marker, so a purchase finished by a `purchase()` retry, by
  `restore()`, or by launch recovery left it behind — and the next reconcile found it neither
  owned nor pending and announced that it had failed. Resolution now happens inside the
  settle path itself, so every route to a settled transaction clears the mark.

- **An out-of-band transaction could never be acknowledged on iOS, and never resolve.** The
  native layer calls `transaction.finish()` *before* notifying listeners, and its
  `acknowledgePurchase` then looks the transaction up in `Transaction.all` and rejects
  "already finished" — which `Transaction.all` guarantees for a finished consumable. That read
  as a settlement failure. An already-finished acknowledge is now success **on that path
  only**; a real acknowledge failure on Android is still a failure.

- **Refunds and revocations accumulated in the recovery store forever.** They verify
  `valid:false` with a code no permanent-error list knows, so they were retained and
  re-verified at every launch, eating the recovery batch that entries which can still succeed
  need. A revocation is no longer persisted — there is nothing to recover from.

- **Reconciliation could report `cancelled` for a purchase that had just cleared.** The owned
  and pending snapshots are two separate native round-trips, and reading owned first meant a
  purchase that cleared in between appeared in neither. Pending is read first now, so that
  window resolves to "still pending".

- **A transaction arriving during or after `destroy()` repopulated the torn-down instance**,
  writing through the shared state closures and the entitlement cache after teardown.

- **`reconcilePending()` ran inside `initialize()`**, so a tracked pending purchase delayed
  `ready` by a store round-trip plus a backend verify, uncapped. It runs just after `ready`
  now.

The local-verification work in this release went through a review pass that found six ways it
could grant or revoke wrongly. All are fixed, and all are worth naming because three of them
broke the invariant this release advertises as untouched:

- **Restore acknowledged transactions the local check had refused.** The adapter reported a
  single consolidated `valid: true`, so the orchestrator acknowledged the whole owned set —
  including purchases just declared invalid, which on Android finalises them and waives Play's
  refund window. `RestoreResponse` gained an optional `verifiedTokens`, and only those are
  acknowledged.

- **Recovery re-granted exactly what a purchase had refused.** Recovery re-verifies from the
  *stored entry*, which kept no binding, no expiry and no purchase state — so an on-device
  check saw an amputated transaction and answered differently than it had at purchase time. A
  refused expired subscription came back one launch later and was granted as *never
  expiring*. The mirror case was as bad: with `verification.appUserId` set, a legitimate
  purchase failed `BINDING_MISMATCH` forever, was never acknowledged, and Google refunded it.
  The entry now persists what a verification needs.

- **A successful purchase replaced the whole entitlement set with that one purchase's.** The
  flows treat a verify response as consolidated, as a backend's is. Buying a consumable
  silently revoked a subscription, in memory and on disk, until the next refresh. Local mode
  now returns the consolidated set.

- **An empty answer from the store wiped everything.** Play resolves its owned-purchases query
  with an empty array when the query *fails* — disconnected service, signed-out account — so
  "owns nothing" and "could not tell you" are identical. `refresh()` treated it as
  authoritative and overwrote the cache, while stamping the entitlements as freshly confirmed.
  Local mode now keeps the current set; a downgrade needs an expiry or an explicit revocation.

- **iOS refunds and revocations passed the check.** `Transaction.all` retains revoked
  transactions and the platform reports the fact locally — so a refunded non-expiring purchase
  granted forever, having no expiry to fall back on. Now refused, with a `REVOKED` reason.

- **The entitlement mapper's output was trusted blindly.** Unlike a backend response it went
  through no schema, so a mapper returning a malformed object cached an entitlement that
  `hasEntitlement` could never match and the next launch silently dropped — and one returning a
  non-array threw a raw `TypeError` out of `purchase()` *after* acknowledging. Validated now;
  a bad mapping grants nothing and logs.

Smaller ones from the same pass: a duplicated entitlement key kept the first derived rather
than the longest-lasting, so a live renewal lost to an older one inside the grace window; two
lookup tables resolved inherited object properties; a numeric Play purchase state skipped its
check; `reset()` emitted an empty `previous` on the one event that removes everything, and
emitted at all when there was nothing to remove.

### Changed

- **`NativeAdapter` gained two optional methods**, `watchTransactions` and
  `getPendingProductIds`. Internal contract; both are optional, so an adapter that omits them
  degrades to reconciliation. `selectNativeAdapter()` now takes a logger, which the capgo
  adapter uses for the best-effort paths that swallow their own failures.

- **`NativeTransaction` gained a required field.** No consumer can produce one — there is no
  config hook for a custom native adapter, and nothing public returns the type — so this is
  additive for anything that only reads one. It is exported, though, so code that *constructs*
  a `NativeTransaction` (a hand-rolled test double, a cast target) needs `purchaseReference`
  added. Prefer `StorePurchase` for anything consumer-facing.

- **`NativeAdapter.getProducts()` now takes whole `ConfiguredProduct` entries** rather than
  `{ id, type }` pairs, because `androidPlanId` is what picks a base plan on Android. Internal
  contract; no public surface changes.

### Documentation

- **A documented audit of the native layer** — [The native layer](https://iap.nossdev.com/guide/native-layer)
  records what `@capgo/native-purchases` guarantees and what it does not, so the boundary
  that caps iap's feature set is written down rather than rediscovered. Audited against
  `8.6.5`: Play Billing Library **8.3.0** (ahead of Google's Billing-8 requirement, so
  nothing to upgrade), licence **MPL-2.0** used unmodified (no copyleft obligation
  propagates to iap or its consumers), and **no device or advertising identifiers** in
  either platform's native source, with an empty `AndroidManifest.xml` that declares no
  permissions of its own.

  Two caveats the page documents because a clean bill of health would have hidden them:
  the Android plugin **writes purchase tokens to logcat in the clear**, ungated (it redacts
  the account identifier, so this reads as an oversight) — iap masks tokens in its own logs,
  but that rule stops at the bridge; and when `androidPlanId` matches no offer, the plugin
  **falls back to the first available base plan instead of failing**, so a stale plan id
  silently purchases something else.
- **Regression guards over the installed plugin** (`tests/unit/native-plugin-contract.test.ts`).
  They read the plugin's own Gradle file, `package.json`, native sources and type
  declarations, so a bump that invalidates a documented guarantee fails CI instead of
  quietly making the docs wrong. The known gaps — no Play purchase signature, no
  `originalTransactionId` field, no intro-offer eligibility query — are asserted
  *inverted*, so capgo adding one of them also fails, as the signal to light up the
  matching iap capability.

## [8.0.0] — 2026-09-04

**The Capacitor 8 line graduates to `@latest`.** `8.0.0-next.0` soaked on the
`@next` dist-tag from 2026-08-17, was exercised against the iOS and Android
store sandboxes, and reported no regressions; this promotes that same code to
general availability. `@latest` moves from `7.1.0` to `8.0.0`.

There are **no functional changes since `8.0.0-next.0`**; see that entry below
for the full delta against `7.1.0`. In short, moving from `7.1.0` is a
peer-dependency bump plus `npx cap sync`, with no consumer code changes: the
`createIAP({ ... })` config, the `IAP` surface, the event map, the error codes
and the backend contract are unchanged.

**Staying on Capacitor 7?**
A bare `npm install @nosslabs/iap` now resolves to the Capacitor 8 line. Pin
`@nosslabs/iap@^7` (or the `@latest-7` dist-tag) with
`@capgo/native-purchases@lts-v7` to stay on Capacitor 7. The `7.x` line
continues from the `7.x` branch, and its documentation is archived at
<https://iap.nossdev.com/v7/>.

### Changed

- **Dist-tags rearranged for the rollover.** `@latest` → `8.0.0` (applied by the
  release workflow). The auxiliary pointers are applied by hand immediately
  after publish: the new `@latest-8` pins the Capacitor 8 line, and `@next` is
  re-pointed at `8.0.0` so it does not sit on a superseded prerelease.
  `@latest-7` continues to track `7.1.0` and `@latest-5` tracks `5.0.0`.
- **Corrected a stale doc comment on `VERSION`.** The published `8.0.0-next.0`
  type declarations described `VERSION` as being "read at runtime by the logger
  so error reports include the version". That was never true — `src/lib/logger.ts`
  uses a fixed `[@nosslabs/iap]` prefix. `VERSION` is exported purely for
  consumers to read. Consumer-visible only on IDE hover; no behaviour change.

### Added

- **Versioned documentation for the `7.x` line** at `/v7/`, a frozen snapshot
  taken at `7.1.0` and reachable from the site's version switcher, mirroring the
  existing `/v5/` archive. Install commands there pin `@^7` throughout, since
  `@latest` no longer resolves to Capacitor 7.

### Internal

Not part of the published package; recorded for contributors.

- **A release gate that loads the built bundle.** CI and the release workflow now
  import `dist/index.cjs` and `dist/index.js` and assert that `VERSION` matches
  `package.json`. The build-time `__PKG_VERSION__` define is otherwise
  unguarded: removing it leaves typecheck, lint, tests and the build all green
  while shipping a bundle that throws `ReferenceError` on import. CI also runs
  `test:coverage` now, so the 80% thresholds are actually enforced.
- **The docs version switcher is built from one shared table**
  (`docs/.vitepress/versions.ts`). `theme/Layout.vue` overwrites `themeConfig.nav`
  per route, so the copy in `config.ts` had been dead code — the `/v5/` archive
  was reachable only because that override happened to hardcode it.

## [8.0.0-next.0] — 2026-08-17

**First release of the Capacitor 8 line, on the `@next` npm dist-tag.** The
Capacitor 7 line continues as `7.x` on `@latest` (and on the new `@latest-7`
dist-tag); `@latest` stays at `7.1.0` until the 8.x line graduates. Install the
candidate with `npm install @nosslabs/iap@next`.

Note that `@next` previously pointed at `7.0.0-next.0`, a Capacitor 7
prerelease; it now moves to the Capacitor 8 line. `7.0.0-next.0` remains
installable by exact version.

**Opens the Capacitor 8 line.** Same library, next platform major: the peer
range moves from Capacitor 7 to Capacitor 8, and nothing else changes. Cap-7
consumers stay on `7.x` — `^7` ranges don't auto-resolve to `8.x`.

### Changed (BREAKING, vs `7.1.0` — peer range only)

- **Anchored the `8.x` line to Capacitor 8.** Peer dependencies moved to
  `@capacitor/core`, `@capacitor/preferences` and (optional) `@capacitor/app`
  at `>=8.0.0` — the forward-open range that upstream `@capacitor/*` plugins
  and `@capgo/native-purchases` themselves declare — and
  `@capgo/native-purchases` at `^8.0.0`, which stays a caret because the
  adapter binds to its method signatures. The Cap-7 ranges
  (`@capacitor/*: ^7.0.0`, `@capgo/native-purchases: ^7.16.2`) are dropped —
  they were the only thing blocking a clean `npm install` in a Capacitor 8 app.
  Upgrading is a peer-dep bump plus `npx cap sync`.
- **`VERSION` is now typed `string` rather than the literal `"0.1.0"`.** It is
  injected from `package.json` at build time instead of being hard-coded, so
  it finally reports the version that is actually installed.

### Fixed

- **CommonJS consumers can type-check again.** The `exports` map declared a
  single top-level `types` entry, so `require()` resolved the CommonJS bundle
  against ESM declarations and `tsc` failed with TS1479 under
  `moduleResolution: node16`/`nodenext`. `types` is now nested per condition,
  with `require` pointing at the `dist/index.d.cts` the build already emitted.
  Affects `7.1.0` and earlier too.
- **`VERSION` no longer reports `0.1.0`.** It was hard-coded and never updated
  by any publish step, so the value every released build exported was wrong.
  (The `8.0.0-next.0` entry claimed this also corrupted logger error reports —
  it did not. `src/lib/logger.ts` uses a fixed `[@nosslabs/iap]` prefix and has
  never read `VERSION`. The export is for consumers only.)

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
