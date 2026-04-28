import { z } from 'zod';
import { selectBackendAdapter } from './adapters/backend/index.js';
import type { BackendAdapter } from './adapters/backend/types.js';
import { selectNativeAdapter } from './adapters/native/index.js';
import type { NativeAdapter } from './adapters/native/types.js';
import { selectStorageAdapter } from './adapters/storage/index.js';
import type { StorageAdapter } from './adapters/storage/types.js';
import { EntitlementCache } from './core/entitlement-cache.js';
import { TypedEventEmitter } from './events/emitter.js';
import { IAPError, IAPErrorCode } from './lib/errors.js';
import { type LogLevel, type Logger, createDefaultLogger, isLogger } from './lib/logger.js';
import { getPlatform, isNative } from './lib/platform.js';
import { type IAPConfig, type IAPConfigInput, iapConfigSchema } from './types/config.js';
import type { EntitlementBase } from './types/entitlement.js';
import type { EventName, EventPayload, Unsubscribe } from './types/events.js';
import type { ConfiguredProduct } from './types/product.js';

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
   * Tear down. Removes event listeners and disposes the native adapter
   * (which clears its `pendingFinish` map and removes the long-lived
   * `.approved()` listener on cdv).
   *
   * NOTE: persisted entitlement cache is NOT cleared. If you're handling
   * a logout for a multi-user app, also call your storage adapter's
   * `clear()` (or the consumer-supplied equivalent) before the next user
   * logs in, otherwise their first read will see the previous user's
   * cached entitlements until `refresh()` returns.
   */
  destroy(): Promise<void>;

  hasEntitlement(key: string): boolean;
  /** Returns a defensive shallow copy. Each entitlement is frozen. */
  getEntitlements(): TEntitlement[];
  /** Returns a frozen entitlement reference, or null if missing. */
  getEntitlement(key: string): TEntitlement | null;

  on<K extends EventName<TEntitlement>>(
    event: K,
    handler: (payload: EventPayload<K, TEntitlement>) => void,
  ): Unsubscribe;
}

interface IAPInternalState<TEntitlement extends EntitlementBase> {
  config: IAPConfig;
  /** Populated by initialize(); null beforehand. Lazy to avoid loading
   *  cordova-plugin-purchase on web platforms (PLAN.md §9 / review C4). */
  adapter: NativeAdapter | null;
  /** Backend transport. Constructed eagerly in the factory so config errors
   *  surface immediately; methods are not invoked until Phase 4 / 6. */
  backend: BackendAdapter<TEntitlement>;
  storage: StorageAdapter;
  cache: EntitlementCache<TEntitlement>;
  emitter: TypedEventEmitter<TEntitlement>;
  logger: Logger;
  initialized: boolean;
  destroyed: boolean;
  entitlements: TEntitlement[];
  /** Timestamp of the cache load. TTL evaluation is deferred to Phase 6 (refresh-flow). */
  cachedAt: number | null;
}

export function createIAP<TEntitlement extends EntitlementBase = EntitlementBase>(
  input: IAPConfigInput,
): IAP<TEntitlement> {
  const config = parseConfig(input);
  const logger = resolveLogger(config.options.logLevel, config.options.logger);
  const storage = selectStorageAdapter(config.storage);
  const cache = new EntitlementCache<TEntitlement>(storage, logger);
  const backend = selectBackendAdapter<TEntitlement>({ config: config.backend, logger });
  const emitter = new TypedEventEmitter<TEntitlement>();

  ensureUniqueProductIds(config.products);

  const state: IAPInternalState<TEntitlement> = {
    config,
    adapter: null,
    backend,
    storage,
    cache,
    emitter,
    logger,
    initialized: false,
    destroyed: false,
    entitlements: [],
    cachedAt: null,
  };

  return {
    async initialize() {
      if (state.destroyed) {
        throw new IAPError({
          code: IAPErrorCode.NOT_INITIALIZED,
          message: 'IAP instance has been destroyed; create a new one with createIAP().',
        });
      }
      if (state.initialized) {
        state.logger.debug('initialize() called more than once; ignoring.');
        return;
      }

      const platform = getPlatform();
      if (!isNative()) {
        state.logger.info(
          'Native purchases unavailable on web; entitlement queries still functional.',
        );
      } else {
        state.logger.debug(`Initializing on platform=${platform}`);
      }

      // Lazy adapter construction — this is the dynamic-import boundary so
      // web builds don't pull in cordova-plugin-purchase.
      state.adapter = await selectNativeAdapter({ products: state.config.products });

      try {
        await state.adapter.isAvailable();
      } catch (error) {
        state.logger.warn('Native adapter availability check threw; continuing.', error);
      }

      const cached = await state.cache.load();
      if (cached) {
        state.entitlements = freezeAll(cached.entitlements);
        state.cachedAt = cached.cachedAt;
        state.logger.debug(
          `Loaded ${cached.entitlements.length} cached entitlement(s) from ${new Date(cached.cachedAt).toISOString()}.`,
        );
      }

      // Phase 6 will wire recovery + app-state listener here.

      state.initialized = true;
      state.emitter.emit('ready', undefined);
    },

    async refresh() {
      requireInitialized(state);
      const previous = state.entitlements;
      const fetched = await state.backend.getEntitlements();
      const next = freezeAll(fetched);

      // Persist + replace state in a single transition. If save() fails the
      // in-memory state still reflects what the backend returned (best-effort
      // cache; the next session will re-fetch on its own refresh).
      try {
        await state.cache.save(next);
        state.cachedAt = Date.now();
      } catch (error) {
        state.logger.warn(
          'Failed to persist refreshed entitlements; in-memory state still updated.',
          error,
        );
      }

      state.entitlements = next;
      state.emitter.emit('entitlements-changed', { entitlements: next, previous });
    },

    async destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      state.initialized = false;
      state.entitlements = [];
      state.cachedAt = null;
      state.emitter.removeAll();

      if (state.adapter?.dispose) {
        try {
          await state.adapter.dispose();
        } catch (error) {
          state.logger.warn('Adapter dispose threw; continuing teardown.', error);
        }
      }
      state.adapter = null;
    },

    hasEntitlement(key) {
      return state.entitlements.some((e) => e.key === key);
    },

    getEntitlements() {
      return [...state.entitlements];
    },

    getEntitlement(key) {
      return state.entitlements.find((e) => e.key === key) ?? null;
    },

    on(event, handler) {
      return state.emitter.on(event, handler);
    },
  };
}

function freezeAll<T extends object>(items: T[]): T[] {
  return items.map((item) => Object.freeze({ ...item }));
}

function parseConfig(input: IAPConfigInput): IAPConfig {
  try {
    return iapConfigSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message: `Invalid IAP configuration:\n${issues}`,
        cause: error,
      });
    }
    throw error;
  }
}

function ensureUniqueProductIds(products: ConfiguredProduct[]): void {
  const seen = new Set<string>();
  for (const product of products) {
    if (seen.has(product.id)) {
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message: `Duplicate product id "${product.id}" in config.products.`,
      });
    }
    seen.add(product.id);
  }
}

function resolveLogger(level: LogLevel, candidate: unknown): Logger {
  if (isLogger(candidate)) return candidate;
  return createDefaultLogger(level);
}

function requireInitialized<TEntitlement extends EntitlementBase>(
  state: IAPInternalState<TEntitlement>,
): void {
  if (!state.initialized) {
    throw new IAPError({
      code: IAPErrorCode.NOT_INITIALIZED,
      message: 'Call iap.initialize() before this method.',
    });
  }
}
