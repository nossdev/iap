import { z } from 'zod';
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
  refresh(): Promise<void>;
  destroy(): Promise<void>;

  hasEntitlement(key: string): boolean;
  getEntitlements(): TEntitlement[];
  getEntitlement(key: string): TEntitlement | null;

  on<K extends EventName<TEntitlement>>(
    event: K,
    handler: (payload: EventPayload<K, TEntitlement>) => void,
  ): Unsubscribe;
}

interface IAPInternalState<TEntitlement extends EntitlementBase> {
  config: IAPConfig;
  adapter: NativeAdapter;
  storage: StorageAdapter;
  cache: EntitlementCache<TEntitlement>;
  emitter: TypedEventEmitter<TEntitlement>;
  logger: Logger;
  initialized: boolean;
  destroyed: boolean;
  entitlements: TEntitlement[];
  cachedAt: number | null;
}

export function createIAP<TEntitlement extends EntitlementBase = EntitlementBase>(
  input: IAPConfigInput,
): IAP<TEntitlement> {
  const config = parseConfig(input);
  const logger = resolveLogger(config.options.logLevel, config.options.logger);
  const adapter = selectNativeAdapter({ products: config.products });
  const storage = selectStorageAdapter(config.storage);
  const cache = new EntitlementCache<TEntitlement>(storage, logger);
  const emitter = new TypedEventEmitter<TEntitlement>();

  ensureUniqueProductIds(config.products);

  const state: IAPInternalState<TEntitlement> = {
    config,
    adapter,
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

      try {
        await state.adapter.isAvailable();
      } catch (error) {
        state.logger.warn('Native adapter availability check threw; continuing.', error);
      }

      const cached = await state.cache.load();
      if (cached) {
        state.entitlements = cached.entitlements;
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
      // Backend HTTP client lands in Phase 3.
      state.logger.debug('refresh() called — backend client not yet implemented (Phase 3).');
    },

    async destroy() {
      state.emitter.removeAll();
      state.destroyed = true;
      state.initialized = false;
      state.entitlements = [];
      state.cachedAt = null;
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
