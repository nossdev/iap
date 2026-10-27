import type { EntitlementBase } from './entitlement.js';
import type { EventName, EventPayload, Unsubscribe } from './events.js';
import type { Product } from './product.js';
import type { PurchaseOptions, PurchaseResult, RestoreResult } from './results.js';
import type { Storefront } from './storefront.js';

export interface IAP<TEntitlement extends EntitlementBase = EntitlementBase> {
  initialize(): Promise<void>;
  /**
   * Refresh entitlements from the consumer backend.
   *
   * Fetches via the configured `BackendAdapter` (HTTP default or custom),
   * freezes results, persists them via the storage adapter, and emits
   * `entitlements-changed`.
   */
  refresh(): Promise<void>;
  /**
   * Tear down. Removes event listeners and disposes the native adapter.
   *
   * NOTE 1: persisted entitlement cache is NOT cleared. If you're handling
   * a logout for a multi-user app, also call your storage adapter's
   * `clear()` (or the consumer-supplied equivalent) before the next user
   * logs in, otherwise their first read will see the previous user's
   * cached entitlements until `refresh()` returns.
   *
   * NOTE 2: calling `destroy()` while a `purchase()` is in flight may
   * leave the result in an inconsistent state — the backend may have
   * recorded the entitlement but the native `acknowledge()` call may not
   * have run yet. On Android this means Google auto-refunds in 3 days
   * (the unfinished-transaction recovery on the next launch re-acks, but
   * only if it runs within that window). Avoid by awaiting the in-flight
   * `purchase()` before calling `destroy()`.
   */
  destroy(): Promise<void>;

  /**
   * Start a purchase. Throws `IAPError` only on impossible states
   * (NOT_INITIALIZED, ALREADY_IN_PROGRESS, PRODUCT_NOT_FOUND,
   * INVALID_APP_USER_ID, APP_USER_ID_FETCH_FAILED); all other
   * outcomes — user cancellation, backend rejection, native errors — are
   * surfaced via the `PurchaseResult` discriminated union so the caller
   * can render the right UI without try/catch gymnastics.
   *
   * `opts.appUserId` is optional. When provided (string or async fetcher
   * returning a string), the resolved value is validated as an RFC 9562
   * UUID of any version and forwarded to StoreKit's `appAccountToken`
   * (iOS) / Play
   * Billing's `obfuscatedAccountId` (Android) — making it available on
   * Attesto's verify response and outbound webhook payload as
   * `appUserId` so backends can join on user identity directly. See
   * `PurchaseOptions` and `AppUserId` for full semantics.
   *
   * Emits `purchase-started`, then exactly one of: `purchase-success`
   * (+ `entitlements-changed`), `purchase-cancelled`, `purchase-pending`,
   * `verification-failed`, or `purchase-failed`.
   */
  purchase(opts: PurchaseOptions): Promise<PurchaseResult<TEntitlement>>;

  /**
   * Re-verify every owned transaction with the consumer backend and
   * refresh entitlements from the consolidated response. Wire this to a
   * "Restore Purchases" button.
   *
   * Returns `{ restored, entitlements }` where `restored` is the number
   * of native transactions submitted (0 on a fresh install with no
   * purchases). Throws `IAPError` on backend rejection or transport
   * failure — wrap the call in try/catch in the consumer's button
   * handler.
   *
   * Emits `restore-started`, then on success `restore-completed` +
   * `entitlements-changed` (the latter only when the entitlements list
   * actually changed). On failure no completion event fires; the thrown
   * error is the only signal.
   *
   * NOTE on the empty-owned-list case: when the platform store reports
   * no owned transactions (fresh install, signed-out Apple ID, etc.),
   * the library short-circuits — it does NOT call the backend and
   * preserves whatever entitlements were already cached in memory. If
   * you suspect cache staleness (e.g. user just signed in to a new
   * Apple ID), call `iap.refresh()` afterward to reconcile against the
   * backend's view of the user's entitlements.
   */
  restorePurchases(): Promise<RestoreResult<TEntitlement>>;

  /**
   * Get product info merged with native pricing. Returns one entry per
   * product the platform store knows about; products configured but not
   * yet ingested by the store are silently skipped (no error).
   */
  getProducts(): Promise<Product[]>;

  /**
   * Read the current storefront — the country the user's App Store / Google
   * Play account is registered to. Use it to drive region-dependent UI:
   * regional offers/pricing, and gating external-payment links whose
   * eligibility the platform itself keys to storefront country (not device
   * locale).
   *
   * `countryCode` is normalized to ISO 3166-1 alpha-2 across platforms (raw
   * native code preserved on `countryCodeRaw`). Resolves `null` when no
   * storefront is available — on web, when the installed
   * `@capgo/native-purchases` doesn't register the native method, when the
   * native call fails, or when the store reports an empty country (e.g. EU
   * alternative distribution).
   *
   * Read live — do not cache. Treat the value as a UX/targeting hint; for
   * compliance- or entitlement-sensitive enforcement, trust the server-side
   * signed storefront from your backend instead.
   */
  getStorefront(): Promise<Storefront | null>;

  /**
   * Whether an **active** entitlement with this key is held.
   *
   * Active means its `expiresAt` has not passed by the device clock, plus
   * any `options.entitlementGraceMs`. An entitlement is never dropped
   * because a refresh failed or the cache is old — only the store's own
   * deadline, or an authoritative negative, takes one away.
   */
  hasEntitlement(key: string): boolean;
  /**
   * The active entitlements, as a defensive shallow copy. Each is frozen.
   * Expired ones are omitted — see {@link IAP.hasEntitlement}.
   */
  getEntitlements(): TEntitlement[];
  /** A frozen active entitlement, or null if missing or expired. */
  getEntitlement(key: string): TEntitlement | null;
  /**
   * When the entitlements were last confirmed by the verification source —
   * your backend, or the device in local mode. ISO 8601, or `null` if they
   * have never been confirmed on this install.
   *
   * Exposed so an app can decide for itself how much staleness it will
   * tolerate. iap deliberately does not revoke on staleness: a cached
   * entitlement stands until it expires, because a network error must never
   * cost a paying user their access.
   */
  getEntitlementsVerifiedAt(): string | null;

  /**
   * Erase everything iap has stored on this device: the entitlement cache,
   * the unfinished-transaction queue, and any pending-purchase marks.
   *
   * For a "delete everything" control. `destroy()` deliberately leaves the
   * cache in place (a new instance should see the user's entitlements
   * immediately); this is the opposite, and does not tear the instance down —
   * the instance stays usable and a `refresh()` will repopulate from the
   * verification source.
   *
   * Best-effort on storage: a failure to clear one key is logged and the
   * rest is still cleared. Emits `entitlements-changed` with an empty list,
   * so a reactive UI follows.
   *
   * Throws `ALREADY_IN_PROGRESS` if a `purchase()` is in flight. That
   * purchase would re-populate the state and re-persist the cache moments
   * after the wipe, and leave its unfinished entry behind, so the erase
   * would look like it had silently failed. Await the purchase, then reset.
   *
   * A no-op after `destroy()`, rather than an error: a teardown racing a
   * "delete my data" tap is a real sequence, not a programming mistake.
   *
   * It does **not** revoke the purchase. The store still owns it, and a
   * restore will bring the entitlement back — which is correct: the user
   * paid.
   */
  reset(): Promise<void>;

  on<K extends EventName<TEntitlement>>(
    event: K,
    handler: (payload: EventPayload<K, TEntitlement>) => void,
  ): Unsubscribe;
}
