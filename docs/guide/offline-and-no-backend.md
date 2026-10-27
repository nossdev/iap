# Offline and no-backend use

iap's default shape is `library → your backend → Attesto`, and that is still the shape to
reach for. This page is about the two cases where it is not available: an app with **no server
at all**, and an app with a server that is **temporarily unreachable**.

They are different problems with different answers, so they are separated below.

## No backend at all

Set `verification` instead of `backend`:

```typescript
import { createIAP } from '@nosslabs/iap';

const iap = createIAP({
  products: [{ id: 'household_yearly', type: 'subscription', androidPlanId: 'yearly' }],
  verification: {
    mode: 'local',
    // iap cannot know what a product entitles anyone to, and there is no
    // backend to ask — so you say.
    entitlements: (purchase) => [
      { key: 'household', productId: purchase.productId, expiresAt: purchase.expiresAt },
    ],
    // Optional: every purchase must carry this binding, or it is refused.
    appUserId: householdBinding,
  },
});
```

Exactly one of `backend` or `verification` is required. Both is a config error — they are two
answers to the same question with no rule for which wins — and neither leaves nothing to gate
an entitlement on.

### What stays the same

All of it, which is the point. Local verification is implemented as a `BackendAdapter`, so
everything above that boundary is untouched:

- The purchase flow, including **acknowledge only after verification succeeds**. A purchase
  whose local check fails is never acknowledged — on any of the three paths that verify one
  (a purchase, a restore, or launch recovery) — so the store keeps it and it is retried. That
  is the same guarantee the backend path gives, and the same protection against Play's 3-day
  auto-refund.
- The at-least-once write to the unfinished-transaction store before verifying, so an app that
  dies mid-purchase recovers.
- `restorePurchases()`, the event stream, the entitlement cache, `refreshOnResume`.

There is no second purchase path to keep in step. `refresh()` and `restorePurchases()` both
answer "what does this store account own", by asking the store — which is why they keep working
with no network at all.

::: warning An empty answer from the store is not a revocation
Play resolves its owned-purchases query with an **empty array when the query fails** — a
disconnected billing service, a signed-out account, a non-OK response code — rather than
rejecting. So "owns nothing" and "could not tell you" look identical.

Local mode therefore **keeps** the current entitlements when the store reports nothing owned,
rather than treating it as authoritative. A downgrade needs a positive signal: an expiry, or a
transaction the store reports as revoked. On iOS a refund *is* such a signal
(`Transaction.all` keeps revoked transactions, and iap refuses them); on Android a refunded
purchase simply disappears, which is indistinguishable from the failure above — so refund
detection there needs the server API.
:::

### What the device can actually check

Four things, and it is worth knowing it is only four:

1. The product is one your app sells (it is in `products`).
2. The purchase carries the expected binding, when you set `verification.appUserId`.
3. On Android, the store reports the purchase as purchased rather than awaiting clearance.
4. A subscription has not expired, by the **device** clock.

### How strong the answer is, per platform

Every verified purchase carries an `assurance`, because the two platforms genuinely differ and
an app deciding what to unlock deserves to know which it got:

| | `assurance` | What it means |
|---|---|---|
| **iOS** | `store-signed` | StoreKit 2 verified Apple's signature over the transaction **in native code** before it reached the WebView. The native layer resolves a purchase only for a verified result and rejects anything else. A cryptographic guarantee, made by the platform. |
| **Android** | `store-reported` | **No cryptographic check is possible on the device.** The native layer exposes neither Play's purchase signature nor the original JSON it is computed over, so this means "Play told this device it owns this". The store's word — which is a real answer, and the same one Play's own client APIs give, but not proof. |

::: danger What this cannot do
Neither level resists a device that is lying. A rooted device can patch the store client, and
the device clock can be set back to extend a subscription. On Android there is additionally no
signature to check at all.

So: local mode is right for an app with no server, where the alternative is no verification at
all. It is **not** a substitute for server-side validation where being wrong is expensive —
where a single fraudulent unlock costs real money, or where you need refund detection, which
needs the store's server API. If you have a backend, use it.
:::

### Reusing the checks in your own adapter

If you would rather write your own `BackendAdapter` — to add your own rules, or to fall back to
a server when one is reachable — the same checks are exported:

```typescript
import { verifyPurchaseOnDevice } from '@nosslabs/iap';

const result = verifyPurchaseOnDevice(transaction, {
  productIds: ['household_yearly'],
  appUserId: householdBinding,
});

if (result.valid) {
  // result.purchase.assurance, .purchaseReference, .expiresAt, .subscription
}
```

## Offline with a backend

Nothing to configure: this is how iap already behaves. Worth stating as guarantees, because
they are the answers to "what happens on the train".

### A failed refresh never downgrades anyone

**The only things that take an entitlement away are an authoritative negative and an expiry.**
A network error, a timeout, a 500, a DNS failure — none of them change the cached entitlements.
`refresh()` throws and the previous state stands.

This is deliberate, and it is the asymmetry to hold on to: wrongly locking out a paying user is
a support ticket and a refund, while wrongly serving a lapsed one costs a few hours of access.
iap errs towards the second.

A corrupt or unreadable cache is likewise treated as empty rather than fatal — a bad cache
never blocks startup.

### Expiry is enforced on the device clock

`hasEntitlement()`, `getEntitlement()` and `getEntitlements()` return only **active**
entitlements: ones whose `expiresAt` has not passed. This needs no network, so a subscription
that lapses while the app is backgrounded stops granting access the moment it lapses, not at
the next successful refresh.

The device clock is the only clock available offline, and it can be wrong. That is the accepted
cost; a backend is the fix if it matters.

### A grace window, if you want one

```typescript
options: {
  // Two hours past expiresAt still counts.
  entitlementGraceMs: 2 * 60 * 60 * 1000,
}
```

Defaults to `0` — the strict reading. Set it because a renewal is not instantaneous: a
subscription that renews at midnight may not have a fresh receipt on the device for minutes or
hours, and locking the user out in that window is the worse error.

Store-side grace periods and billing retry can run much longer. On Android those are
**server-side only** — the native layer cannot see them — so a backendless Android app has no
way to know it is in one, and this window is the only cushion it has.

### Knowing how stale the answer is

```typescript
const verifiedAt = iap.getEntitlementsVerifiedAt(); // ISO 8601, or null
```

When the entitlements were last confirmed by the verification source. iap deliberately does
**not** revoke on staleness, however old that is — see the asymmetry above — so this is exposed
for an app that wants to be stricter than iap is, or simply to show "last checked".

## Privacy

The privacy guarantees are mode-independent and live in one place:
[Safety guarantees § Privacy](/guide/safety-guarantees#_8-privacy). In short — no telemetry,
no device identifiers, no generated user id, and only three keys stored.

Worth repeating here because it bears on running without a server: in local mode iap makes
**no network request at all**, so there is nothing to opt out of.

### Erasing everything

```typescript
await iap.reset();
```

Wipes the three keys iap owns — the entitlement cache, the unfinished-transaction queue and
the pending-purchase marks — and then clears the configured storage namespace, to catch
anything an older version wrote. For a "delete everything" control.

::: tip If you pass a custom storage adapter
That last step calls `clear()` on **your** adapter, so it wipes whatever scope your adapter
covers. If you share one adapter between iap and your own app data, give iap its own namespace
or its own adapter.
:::

Two things it is not:

- **Not `destroy()`.** That tears the instance down and deliberately *keeps* the cache, so the
  next instance sees the user's entitlements immediately. `reset()` is the opposite: the
  instance stays usable, and a `refresh()` repopulates from the verification source.
- **Not a revocation.** The store still owns the purchase, because the user paid for it, and a
  restore will bring the entitlement back. `reset()` erases iap's record, not the store's.

It is best-effort and never throws: a storage failure is logged and the rest is still cleared.
