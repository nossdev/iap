import type { StorageAdapter } from '../adapters/storage/types.js';
import { IAPError, IAPErrorCode } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { entitlementBaseSchema } from '../types/entitlement.js';
import type { EntitlementBase } from '../types/entitlement.js';
import { isExpired } from './local-verification.js';

const ENTITLEMENTS_KEY = 'entitlements';

interface CacheEnvelope<T> {
  entitlements: T[];
  cachedAt: number;
}

export interface CacheLoadResult<T extends EntitlementBase> {
  entitlements: T[];
  cachedAt: number;
}

/**
 * Persists the consumer's entitlements list to a {@link StorageAdapter}
 * with a cachedAt timestamp so refresh logic (Phase 6) can reason
 * about staleness.
 *
 * Generic over `TEntitlement` so consumer-defined fields pass through.
 * Validates only the {@link EntitlementBase} subset on read; if the
 * stored payload is structurally wrong we drop the cache rather than
 * crash, since stale or corrupt cache should never block the app.
 */
export class EntitlementCache<TEntitlement extends EntitlementBase> {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<CacheLoadResult<TEntitlement> | null> {
    let raw: string | null;
    try {
      raw = await this.storage.get(ENTITLEMENTS_KEY);
    } catch (cause) {
      this.logger.warn('Storage read failed; treating cache as empty.', cause);
      return null;
    }
    if (!raw) return null;

    let parsed: CacheEnvelope<unknown>;
    try {
      parsed = JSON.parse(raw) as CacheEnvelope<unknown>;
    } catch (cause) {
      this.logger.warn('Cached entitlements payload is not valid JSON; clearing.', cause);
      await this.safeRemove();
      return null;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.cachedAt !== 'number' ||
      !Array.isArray(parsed.entitlements)
    ) {
      this.logger.warn('Cached entitlements envelope has unexpected shape; clearing.');
      await this.safeRemove();
      return null;
    }

    const validated: TEntitlement[] = [];
    for (const item of parsed.entitlements) {
      const result = entitlementBaseSchema.safeParse(item);
      if (!result.success) {
        this.logger.warn('Dropping cached entitlement that fails base validation.', result.error);
        continue;
      }
      validated.push(item as TEntitlement);
    }

    return { entitlements: validated, cachedAt: parsed.cachedAt };
  }

  /** Returns the `cachedAt` timestamp written so callers can keep their
   *  in-memory copy of the timestamp in sync with disk. */
  async save(entitlements: TEntitlement[]): Promise<number> {
    const cachedAt = Date.now();
    const envelope: CacheEnvelope<TEntitlement> = {
      entitlements,
      cachedAt,
    };
    try {
      await this.storage.set(ENTITLEMENTS_KEY, JSON.stringify(envelope));
    } catch (cause) {
      throw new IAPError({
        code: IAPErrorCode.STORAGE_ERROR,
        message: 'Failed to persist entitlement cache.',
        cause,
        recoverable: true,
      });
    }
    return cachedAt;
  }

  async clear(): Promise<void> {
    await this.safeRemove();
  }

  private async safeRemove(): Promise<void> {
    try {
      await this.storage.remove(ENTITLEMENTS_KEY);
    } catch (cause) {
      this.logger.warn('Failed to remove corrupt entitlement cache.', cause);
    }
  }
}

/**
 * The entitlements that are still active, by the **device** clock.
 *
 * iap's offline rule, in one function: an entitlement is dropped only when
 * its `expiresAt` has passed (plus any configured grace), never because a
 * refresh failed or the cache is old. A network error must not downgrade
 * anyone — the cached answer stands until the store's own deadline says
 * otherwise, or until an authoritative negative replaces it.
 *
 * The device clock can be wrong, and a user who sets it back can extend a
 * subscription. That is the price of answering offline at all; a backend is
 * the fix if it matters.
 */
export function activeEntitlements<T extends EntitlementBase>(
  entitlements: readonly T[],
  now: number,
  graceMs = 0,
): T[] {
  return entitlements.filter((entitlement) => !isExpired(entitlement.expiresAt, now, graceMs));
}

/**
 * Shallow-equal comparator on the {@link EntitlementBase} fields.
 * Used by the orchestrators to skip emitting `entitlements-changed` when
 * a refresh / recovery / restore returns content-identical lists — avoids
 * spurious re-renders in reactive consumer stores.
 *
 * "Content-identical" means: same length, same `(key, productId, expiresAt)`
 * triples in the same order. Consumer-defined fields are NOT compared
 * because the library doesn't know their shape — if you need finer-grained
 * change detection, subscribe and run your own equality check on payload.
 */
export function entitlementsEqual(a: EntitlementBase[], b: EntitlementBase[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.key !== y.key || x.productId !== y.productId || x.expiresAt !== y.expiresAt) {
      return false;
    }
  }
  return true;
}
