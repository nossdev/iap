import { z } from 'zod';
import type { StorageAdapter } from '../adapters/storage/types.js';
import type { Logger } from '../lib/logger.js';
import { type MutationLock, createMutationLock } from './mutation-lock.js';

const STORE_KEY = 'pending_purchases';

/**
 * An entry carries when it was marked, so a mark that can never resolve
 * does not live forever. See {@link MAX_PENDING_AGE_MS}.
 *
 * The bare-string form is what earlier versions wrote. Accepted on read so
 * an upgrade does not drop a live pending purchase; such an entry has no
 * recorded time, so it is treated as marked now and ages from this launch.
 */
const pendingEntrySchema = z.union([
  z.object({ productId: z.string().min(1), recordedAt: z.string().min(1) }),
  z
    .string()
    .min(1)
    .transform((productId) => ({ productId, recordedAt: '' })),
]);

const pendingListSchema = z.array(pendingEntrySchema);

interface PendingEntry {
  productId: string;
  /** ISO 8601, or `''` for an entry written before this field existed. */
  recordedAt: string;
}

/**
 * How long a pending mark is kept.
 *
 * It exists for the iOS case that cannot otherwise end: a deferred
 * (Ask-to-Buy) purchase that is declined produces no signal at all, and
 * StoreKit offers no way to enumerate deferred purchases — so iap can never
 * learn that mark is dead. Left alone it would survive for the life of the
 * install and make every single foreground ask the store for its owned
 * transactions.
 *
 * 30 days is well past any real clearance window (Play's cash and e-wallet
 * flows are hours to days) while still bounding the cost. An expired mark is
 * dropped **silently** — no `cancelled` event — because expiry is iap giving
 * up on knowing, not the store saying the purchase failed.
 */
const MAX_PENDING_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The product ids iap has told the consumer are awaiting clearance — the
 * ones it emitted `purchase-pending` for.
 *
 * It exists because a pending purchase resolves **out of band and possibly
 * in another session**. Play's e-wallet and cash flows can take hours; the
 * app is usually closed by the time the money arrives. Without a record
 * that survives a launch, iap could never tell the consumer the pending
 * state had ended, and a paywall would sit on "waiting for payment" until
 * the user reinstalled.
 *
 * Deliberately only product ids, not transactions: a pending Play purchase
 * has no token worth keeping (it is not owned yet), and the only question
 * being tracked is "did the thing we announced ever resolve".
 *
 * Tolerant like the other stores: a corrupt payload reads as empty rather
 * than throwing, because a lost pending marker costs a stale UI hint, while
 * a throw here would break `initialize()`.
 */
export class PendingPurchasesStore {
  private readonly runExclusive: MutationLock = createMutationLock();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly logger: Logger,
  ) {}

  /** Product ids currently marked pending, or `[]` if empty / corrupt. */
  async list(): Promise<string[]> {
    return (await this.readLive()).map((entry) => entry.productId);
  }

  /** Live entries, with anything past {@link MAX_PENDING_AGE_MS} dropped. */
  private async readLive(): Promise<PendingEntry[]> {
    let raw: string | null;
    try {
      raw = await this.storage.get(STORE_KEY);
    } catch (cause) {
      this.logger.warn('Storage read failed; treating pending list as empty.', cause);
      return [];
    }
    if (!raw) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      this.logger.warn('pending_purchases payload is not valid JSON; clearing.', cause);
      await this.safeRemove();
      return [];
    }

    const result = pendingListSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn('pending_purchases has unexpected shape; clearing.', result.error);
      await this.safeRemove();
      return [];
    }

    const now = Date.now();
    const live = result.data.filter((entry) => {
      // An entry with no recorded time came from a version before the field
      // existed. Keep it and let it age from now rather than guessing.
      if (entry.recordedAt === '') return true;
      const marked = Date.parse(entry.recordedAt);
      if (Number.isNaN(marked)) return false;
      return now - marked < MAX_PENDING_AGE_MS;
    });

    if (live.length !== result.data.length) {
      this.logger.debug(
        `Dropping ${result.data.length - live.length} pending mark(s) past the age limit.`,
      );
      // Best-effort: re-reading is cheap and a lost prune just re-prunes.
      await this.persist(live);
    }
    return live;
  }

  async has(productId: string): Promise<boolean> {
    return (await this.list()).includes(productId);
  }

  /**
   * Remove a product's pending mark and report whether it was there.
   *
   * The atomic form of `has()` then `remove()`, and the reason it exists:
   * `purchase-pending-resolved` promises to fire at most once per pending
   * purchase, and the two callers that resolve one can run concurrently —
   * the iOS transaction listener is fire-and-forget, so it can interleave
   * with the reconciliation that runs on resume. Checked and removed
   * separately, both would observe the mark and both would emit.
   */
  async takeIfPresent(productId: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const current = await this.readLive();
      if (!current.some((entry) => entry.productId === productId)) return false;
      await this.persist(current.filter((entry) => entry.productId !== productId));
      return true;
    });
  }

  /** Mark a product pending. Idempotent — re-marking does not reset the age. */
  async add(productId: string): Promise<void> {
    return this.runExclusive(async () => {
      const current = await this.readLive();
      if (current.some((entry) => entry.productId === productId)) return;
      await this.persist([...current, { productId, recordedAt: new Date().toISOString() }]);
    });
  }

  /** Clear a product's pending mark. No-op if absent. */
  async remove(productId: string): Promise<void> {
    return this.runExclusive(async () => {
      const current = await this.readLive();
      const next = current.filter((entry) => entry.productId !== productId);
      if (next.length === current.length) return;
      await this.persist(next);
    });
  }

  /** Drop every pending mark. Used by `iap.reset()`. */
  async clear(): Promise<void> {
    return this.runExclusive(() => this.safeRemove());
  }

  private async persist(entries: PendingEntry[]): Promise<void> {
    try {
      await this.storage.set(STORE_KEY, JSON.stringify(entries));
    } catch (cause) {
      // Best-effort, unlike the unfinished store: losing a pending marker
      // costs a stale UI hint, not a purchase. Never throw into a caller
      // that is reporting a pending result to the consumer.
      this.logger.warn('Failed to persist pending_purchases; pending state may be lost.', cause);
    }
  }

  private async safeRemove(): Promise<void> {
    try {
      await this.storage.remove(STORE_KEY);
    } catch (cause) {
      this.logger.warn('Failed to clear pending_purchases key.', cause);
    }
  }
}
