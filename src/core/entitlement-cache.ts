import type { StorageAdapter } from '../adapters/storage/types.js';
import { IAPError, IAPErrorCode } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { entitlementBaseSchema } from '../types/entitlement.js';
import type { EntitlementBase } from '../types/entitlement.js';

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

  async save(entitlements: TEntitlement[]): Promise<void> {
    const envelope: CacheEnvelope<TEntitlement> = {
      entitlements,
      cachedAt: Date.now(),
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
