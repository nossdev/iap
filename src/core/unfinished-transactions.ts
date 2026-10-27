import { z } from 'zod';
import type { StorageAdapter } from '../adapters/storage/types.js';
import { IAPError, IAPErrorCode, toIAPError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { productTypeSchema } from '../types/config.js';
import type { NativeTransaction } from '../types/transaction.js';
import { type MutationLock, createMutationLock } from './mutation-lock.js';
import { IAP_STORAGE_KEYS } from './storage-keys.js';

const STORE_KEY = IAP_STORAGE_KEYS.unfinishedTransactions;

const unfinishedEntrySchema = z.object({
  platform: z.enum(['apple', 'google']),
  productId: z.string().min(1),
  token: z.string().min(1),
  productType: productTypeSchema,
  packageName: z.string().optional(),
  /**
   * The renewal-stable purchase reference. Optional, and deliberately
   * unconstrained beyond its type: entries written before it existed are
   * still valid, and readers fall back to `token`. A `min(1)` here would
   * make an empty string fail the whole entry's parse — rejecting a
   * recoverable purchase over a field recovery does not even read.
   */
  purchaseReference: z.string().optional(),
  /**
   * The fields a verification needs that the extracted request shapes do
   * not carry. All optional, so entries written before they existed still
   * parse.
   *
   * These exist because recovery re-verifies from the **stored entry**, not
   * from a live transaction. Without them a rebuilt transaction has no
   * binding, no expiry and no purchase state — so an on-device check sees
   * an amputated object and answers differently than it did at purchase
   * time: an expired subscription verifies as non-expiring and is granted,
   * and a purchase with a binding fails `BINDING_MISMATCH` forever and is
   * never acknowledged (which on Android means Google refunds it).
   */
  appUserId: z.string().optional(),
  expiresAt: z.string().optional(),
  purchaseState: z.string().optional(),
  /** ISO 8601 timestamp the entry was first persisted. */
  recordedAt: z.string(),
});

/**
 * Entries are validated one at a time rather than as an array, so one
 * unreadable entry cannot take its neighbours down with it. Parsing the
 * whole array meant a single malformed record failed the parse and cleared
 * every pending recovery — abandoning purchases that were paid for and
 * never acknowledged, which on Android Google refunds after three days.
 */
const entryListSchema = z.array(z.unknown());

export type UnfinishedTransaction = z.infer<typeof unfinishedEntrySchema>;

/**
 * Persistent store for transactions that have completed natively (the user's
 * purchase succeeded with the platform store) but have NOT yet been verified
 * by the consumer backend.
 *
 * Lifecycle:
 *  1. Purchase orchestrator writes the entry BEFORE calling backend verify.
 *  2. On backend success, the orchestrator removes the entry and acks natively.
 *  3. If the app dies between (1) and acking, recovery on next `initialize()`
 *     reads this list and re-attempts verification (Phase 6).
 *
 * Same tolerance pattern as {@link EntitlementCache}: malformed JSON is dropped
 * silently and reported as an empty list rather than crashing initialize.
 */
export class UnfinishedTransactionsStore {
  /**
   * Serializes mutating operations (`add` / `remove`) so concurrent callers
   * don't race the read-modify-write on the storage key. Phase 6's
   * parallel recovery exposed this — multiple `remove()` calls in flight
   * could each `list()` the same snapshot and overwrite each other's
   * `persist()`.
   */
  private readonly runExclusive: MutationLock = createMutationLock();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly logger: Logger,
  ) {}

  /** Returns the current list, or `[]` if empty / corrupt. */
  async list(): Promise<UnfinishedTransaction[]> {
    let raw: string | null;
    try {
      raw = await this.storage.get(STORE_KEY);
    } catch (cause) {
      this.logger.warn('Storage read failed; treating unfinished list as empty.', cause);
      return [];
    }
    if (!raw) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      this.logger.warn('unfinished_transactions payload is not valid JSON; clearing.', cause);
      await this.safeClear();
      return [];
    }

    const list = entryListSchema.safeParse(parsed);
    if (!list.success) {
      // Not a list at all — nothing here is salvageable.
      this.logger.warn('unfinished_transactions is not a list; clearing.', list.error);
      await this.safeClear();
      return [];
    }

    const entries: UnfinishedTransaction[] = [];
    let dropped = 0;
    for (const candidate of list.data) {
      const entry = unfinishedEntrySchema.safeParse(candidate);
      if (entry.success) {
        entries.push(entry.data);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      this.logger.warn(
        `Dropped ${dropped} unreadable unfinished-transaction entry/entries; kept ${entries.length}.`,
      );
    }
    return entries;
  }

  /**
   * Append a transaction to the list. Idempotent: if a same-token entry
   * already exists, this is a no-op (avoids dupes when restore + active
   * purchase race for the same StoreKit replay).
   *
   * **Keyed on `token`, deliberately — not on `purchaseReference`.** The
   * token is what acknowledges one transaction, and on iOS a subscription
   * has a separate token per renewal while sharing one reference. Keying
   * on the reference would collapse several unacknowledged renewals into
   * one entry and leave the rest unfinished.
   */
  async add(tx: NativeTransaction): Promise<void> {
    return this.runExclusive(async () => {
      const current = await this.list();
      if (current.some((e) => e.token === tx.token)) return;
      const entry: UnfinishedTransaction = {
        platform: tx.platform,
        productId: tx.productId,
        token: tx.token,
        productType: tx.productType,
        ...(tx.packageName ? { packageName: tx.packageName } : {}),
        ...(tx.purchaseReference ? { purchaseReference: tx.purchaseReference } : {}),
        ...(tx.appUserId ? { appUserId: tx.appUserId } : {}),
        ...(tx.subscription?.expiresAt ? { expiresAt: tx.subscription.expiresAt } : {}),
        ...(typeof (tx.raw as { purchaseState?: unknown } | undefined)?.purchaseState ===
          'string' ||
        typeof (tx.raw as { purchaseState?: unknown } | undefined)?.purchaseState === 'number'
          ? {
              purchaseState: String((tx.raw as { purchaseState?: unknown }).purchaseState),
            }
          : {}),
        recordedAt: new Date().toISOString(),
      };
      await this.persist([...current, entry]);
    });
  }

  /** Remove the entry with the given token. No-op if not present. */
  async remove(token: string): Promise<void> {
    return this.runExclusive(async () => {
      const current = await this.list();
      const next = current.filter((e) => e.token !== token);
      if (next.length === current.length) return;
      await this.persist(next);
    });
  }

  /** Clear every unfinished entry. */
  async clear(): Promise<void> {
    return this.runExclusive(() => this.safeClear());
  }

  private async persist(entries: UnfinishedTransaction[]): Promise<void> {
    try {
      await this.storage.set(STORE_KEY, JSON.stringify(entries));
    } catch (cause) {
      // `toIAPError`, not a fresh IAPError: an error that already *is* an
      // IAPError keeps its own code. A storage adapter can fail for a
      // reason that is not transient — `PreferencesAdapter` raises
      // INVALID_CONFIG when its plugin is not installed — and flattening
      // that to a `recoverable: true` STORAGE_ERROR is what the recovery
      // loop acts on, so the entry would be retried at every launch
      // forever for a cause no retry can fix.
      throw toIAPError(
        cause,
        'Failed to persist unfinished transactions list.',
        IAPErrorCode.STORAGE_ERROR,
      );
    }
  }

  private async safeClear(): Promise<void> {
    try {
      await this.storage.remove(STORE_KEY);
    } catch (cause) {
      this.logger.warn('Failed to clear unfinished_transactions key.', cause);
    }
  }
}
