import { z } from 'zod';
import { selectBackendAdapter } from './adapters/backend/index.js';
import type { BackendAdapter } from './adapters/backend/types.js';
import { selectStorageAdapter } from './adapters/storage/index.js';
import { EntitlementCache, entitlementsEqual } from './core/entitlement-cache.js';
import { type IAPInternalState, freezeAll, requireInitialized } from './core/iap-state.js';
import { ensureUniqueProductIds } from './core/iap-state.js';
import { initializeIap } from './core/initialize.js';
import { PendingPurchasesStore } from './core/pending-purchases.js';
import { activeNow, resetIap } from './core/reset.js';
import { UnfinishedTransactionsStore } from './core/unfinished-transactions.js';
import { TypedEventEmitter } from './events/emitter.js';
import { IAPError, IAPErrorCode } from './lib/errors.js';
import { type LogLevel, type Logger, createDefaultLogger, isLogger } from './lib/logger.js';
import { type IAPConfig, type IAPConfigInput, iapConfigSchema } from './types/config.js';
import type { EntitlementBase } from './types/entitlement.js';
import type { IAP } from './types/iap.js';
import type { ConfiguredProduct } from './types/product.js';

export type { IAP } from './types/iap.js';

export function createIAP<TEntitlement extends EntitlementBase = EntitlementBase>(
  input: IAPConfigInput<TEntitlement>,
): IAP<TEntitlement> {
  const config = parseConfig(input);
  const logger = resolveLogger(config.options.logLevel, config.options.logger);
  const storage = selectStorageAdapter(config.storage);
  const cache = new EntitlementCache<TEntitlement>(storage, logger);
  const unfinished = new UnfinishedTransactionsStore(storage, logger);
  const pending = new PendingPurchasesStore(storage, logger);
  const backend = selectBackendAdapter<TEntitlement>({
    config,
    logger,
    getNativeAdapter: () => state.adapter,
    getProducts: () => state.products,
    getCurrentEntitlements: () => state.entitlements,
  });
  const emitter = new TypedEventEmitter<TEntitlement>();

  // Validate the static manifest eagerly so config typos surface synchronously.
  // The dynamic-manifest path validates inside initialize() once the backend
  // returns the response.
  if (config.products) {
    ensureUniqueProductIds(config.products);
  }

  const state: IAPInternalState<TEntitlement> = {
    config,
    adapter: null,
    backend,
    storage,
    cache,
    unfinished,
    pending,
    orchestrator: null,
    restorer: null,
    recoverer: null,
    updates: null,
    txWatch: null,
    resumeListener: null,
    emitter,
    logger,
    initialized: false,
    destroyed: false,
    entitlements: [],
    cachedAt: null,
    products: Object.freeze([...(config.products ?? [])]) as ConfiguredProduct[],
  };

  // Refresh implementation lives outside the returned object literal so
  // internal callers (the app-resume listener, the TTL microtask) can invoke
  // it directly without going through `this.refresh()` — that pattern would
  // break if a consumer destructured `initialize` from the iap object. The
  // public `refresh` method below just delegates to this function.
  async function refreshEntitlements(): Promise<void> {
    requireInitialized(state);
    const previous = state.entitlements;
    const fetched = await state.backend.getEntitlements();
    const next = freezeAll(fetched);

    // Persist + replace state in a single transition. If save() fails the
    // in-memory state still reflects what the backend returned (best-effort
    // cache; the next session will re-fetch on its own refresh).
    try {
      state.cachedAt = await state.cache.save(next);
    } catch (error) {
      state.logger.warn(
        'Failed to persist refreshed entitlements; in-memory state still updated.',
        error,
      );
    }

    state.entitlements = next;
    // L3: skip the emit when content is unchanged.
    if (!entitlementsEqual(previous, next)) {
      state.emitter.emit('entitlements-changed', { entitlements: next, previous });
    }
  }

  return {
    async initialize() {
      return initializeIap(state, refreshEntitlements);
    },

    refresh: refreshEntitlements,

    async destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      state.initialized = false;
      state.entitlements = [];
      state.cachedAt = null;
      state.emitter.removeAll();

      if (state.resumeListener) {
        try {
          await state.resumeListener.remove();
        } catch (error) {
          state.logger.warn('Resume listener remove threw; continuing teardown.', error);
        }
        state.resumeListener = null;
      }

      if (state.txWatch) {
        try {
          await state.txWatch.remove();
        } catch (error) {
          state.logger.warn('Transaction listener remove threw; continuing teardown.', error);
        }
        state.txWatch = null;
      }

      if (state.adapter?.dispose) {
        try {
          await state.adapter.dispose();
        } catch (error) {
          state.logger.warn('Adapter dispose threw; continuing teardown.', error);
        }
      }
      state.adapter = null;
      state.orchestrator = null;
      state.restorer = null;
      state.recoverer = null;
      state.updates = null;
    },

    async purchase(opts) {
      requireInitialized(state);
      // orchestrator is set in initialize() alongside the native adapter,
      // so it's always present once initialized=true.
      if (!state.orchestrator) {
        throw new IAPError({
          code: IAPErrorCode.NOT_INITIALIZED,
          message: 'Purchase orchestrator not constructed; this is a library bug.',
        });
      }
      return state.orchestrator.purchase(opts);
    },

    async restorePurchases() {
      requireInitialized(state);
      if (!state.restorer) {
        throw new IAPError({
          code: IAPErrorCode.NOT_INITIALIZED,
          message: 'Restore orchestrator not constructed; this is a library bug.',
        });
      }
      return state.restorer.restorePurchases();
    },

    async getProducts() {
      requireInitialized(state);
      // requireInitialized() guarantees state.adapter is set; the explicit
      // null-check below matches the same defensive pattern used by purchase().
      if (!state.adapter) {
        throw new IAPError({
          code: IAPErrorCode.NOT_INITIALIZED,
          message: 'Native adapter not constructed; this is a library bug.',
        });
      }
      // Pass the manifest entries whole: the adapter needs `androidPlanId`
      // to pick a base plan on Android.
      return state.adapter.getProducts([...state.products]);
    },

    async getStorefront() {
      requireInitialized(state);
      // Adapter is guaranteed set once initialized (see getProducts()); the
      // `?.` on getStorefront covers adapters that don't implement the
      // optional method, and `?? null` keeps the contract total.
      return state.adapter?.getStorefront?.() ?? null;
    },

    hasEntitlement(key) {
      return activeNow(state).some((e) => e.key === key);
    },

    getEntitlements() {
      return activeNow(state);
    },

    getEntitlement(key) {
      return activeNow(state).find((e) => e.key === key) ?? null;
    },

    getEntitlementsVerifiedAt() {
      return state.cachedAt === null ? null : new Date(state.cachedAt).toISOString();
    },

    async reset() {
      return resetIap(state);
    },

    on(event, handler) {
      return state.emitter.on(event, handler);
    },
  };
}

function parseConfig(input: IAPConfigInput): IAPConfig {
  try {
    // Schema's `superRefine` has runtime-validated that the function-typed
    // fields ARE functions (or that an adapter is provided instead). The
    // overlay type on IAPConfig narrows them from `unknown` to their proper
    // contracts. Cast at this boundary, not at every use site.
    const parsed = iapConfigSchema.parse(input);
    return parsed as unknown as IAPConfig;
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

function resolveLogger(level: LogLevel, candidate: unknown): Logger {
  if (isLogger(candidate)) return candidate;
  return createDefaultLogger(level);
}
