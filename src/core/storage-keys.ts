/**
 * Every storage key iap owns, in one place.
 *
 * It exists for `reset()`. The keys used to be declared in three separate
 * store modules, so "erase everything iap stored" was a hand-maintained list
 * that happened to match — and a future store added without someone
 * remembering to touch `reset()` would have survived a delete-everything
 * silently, which is the kind of bug nobody finds until it matters.
 *
 * Adding a store means adding its key here, and the test over
 * {@link IAP_STORAGE_KEYS} is what makes forgetting fail loudly rather than
 * quietly.
 *
 * These are relative to the configured storage namespace (`nosslabs_iap` by
 * default), not absolute — the storage adapter prefixes them.
 */
export const IAP_STORAGE_KEYS = {
  /** The entitlement cache envelope. See `EntitlementCache`. */
  entitlements: 'entitlements',
  /** Purchases awaiting backend confirmation. See `UnfinishedTransactionsStore`. */
  unfinishedTransactions: 'unfinished_transactions',
  /** Products reported as awaiting clearance. See `PendingPurchasesStore`. */
  pendingPurchases: 'pending_purchases',
} as const;

export type IapStorageKey = (typeof IAP_STORAGE_KEYS)[keyof typeof IAP_STORAGE_KEYS];

/**
 * The keys as a list, for anything that clears or audits all of them.
 *
 * Frozen, not merely typed `readonly`: `Object.values()` hands back an
 * ordinary mutable array, and a caller that spliced it would quietly shrink
 * what `reset()` erases.
 */
export const ALL_IAP_STORAGE_KEYS: readonly IapStorageKey[] = Object.freeze(
  Object.values(IAP_STORAGE_KEYS),
);
