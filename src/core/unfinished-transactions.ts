import { z } from 'zod';
import type { StorageAdapter } from '../adapters/storage/types.js';
import { IAPError, IAPErrorCode } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { productTypeSchema } from '../types/config.js';
import type { NativeTransaction } from '../types/transaction.js';

const STORE_KEY = 'unfinished_transactions';

const unfinishedEntrySchema = z.object({
  platform: z.enum(['apple', 'google']),
  productId: z.string().min(1),
  token: z.string().min(1),
  productType: productTypeSchema,
  packageName: z.string().optional(),
  /** ISO 8601 timestamp the entry was first persisted. */
  recordedAt: z.string(),
});

const envelopeSchema = z.array(unfinishedEntrySchema);

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
  private mutationLock: Promise<void> = Promise.resolve();

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

    const result = envelopeSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn('unfinished_transactions has unexpected shape; clearing.', result.error);
      await this.safeClear();
      return [];
    }
    return result.data;
  }

  /**
   * Append a transaction to the list. Idempotent: if a same-token entry
   * already exists, this is a no-op (avoids dupes when restore + active
   * purchase race for the same StoreKit replay).
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

  /**
   * Run `fn` with exclusive access to the storage key. Implements a simple
   * promise chain — every mutation awaits the previous one's completion.
   * Reads (`list()`) are NOT serialized because they're tolerant of stale
   * snapshots (callers either compose or accept the read-once semantic).
   */
  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutationLock;
    let release!: () => void;
    this.mutationLock = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  private async persist(entries: UnfinishedTransaction[]): Promise<void> {
    try {
      await this.storage.set(STORE_KEY, JSON.stringify(entries));
    } catch (cause) {
      throw new IAPError({
        code: IAPErrorCode.STORAGE_ERROR,
        message: 'Failed to persist unfinished transactions list.',
        cause,
        recoverable: true,
      });
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
