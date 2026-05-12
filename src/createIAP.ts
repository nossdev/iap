import { z } from 'zod';
import { selectBackendAdapter } from './adapters/backend/index.js';
import type { BackendAdapter } from './adapters/backend/types.js';
import { selectNativeAdapter } from './adapters/native/index.js';
import type { NativeAdapter } from './adapters/native/types.js';
import { selectStorageAdapter } from './adapters/storage/index.js';
import type { StorageAdapter } from './adapters/storage/types.js';
import {
  type AppResumeListenerHandle,
  attachAppResumeListener,
} from './core/app-resume-listener.js';
import { EntitlementCache, entitlementsEqual } from './core/entitlement-cache.js';
import { PurchaseOrchestrator } from './core/purchase-flow.js';
import { DEFAULT_PERMANENT_ERROR_CODES, RecoveryOrchestrator } from './core/recovery-flow.js';
import { RestoreOrchestrator } from './core/restore-flow.js';
import { UnfinishedTransactionsStore } from './core/unfinished-transactions.js';
import { TypedEventEmitter } from './events/emitter.js';
import { IAPError, IAPErrorCode } from './lib/errors.js';
import { type LogLevel, type Logger, createDefaultLogger, isLogger } from './lib/logger.js';
import { getPlatform, isNative } from './lib/platform.js';
import {
  type IAPConfig,
  type IAPConfigInput,
  configuredProductsArraySchema,
  iapConfigSchema,
} from './types/config.js';
import type { EntitlementBase } from './types/entitlement.js';
import type { EventName, EventPayload, Unsubscribe } from './types/events.js';
import type { ConfiguredProduct, Product } from './types/product.js';
import type { PurchaseOptions, PurchaseResult, RestoreResult } from './types/results.js';

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
   * returning a string), the resolved value is validated as a UUID v4
   * and forwarded to StoreKit's `appAccountToken` (iOS) / Play
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
   *  `@capgo/native-purchases` on web platforms (PLAN.md §9 / review C4). */
  adapter: NativeAdapter | null;
  /** Backend transport. Constructed eagerly in the factory so config errors
   *  surface immediately; methods are not invoked until refresh()/purchase(). */
  backend: BackendAdapter<TEntitlement>;
  storage: StorageAdapter;
  cache: EntitlementCache<TEntitlement>;
  unfinished: UnfinishedTransactionsStore;
  /** Constructed lazily in initialize() once the native adapter is resolved. */
  orchestrator: PurchaseOrchestrator<TEntitlement> | null;
  /** Constructed alongside the orchestrator in initialize(). */
  restorer: RestoreOrchestrator<TEntitlement> | null;
  /** Constructed alongside the orchestrator; recovery runs once at init. */
  recoverer: RecoveryOrchestrator<TEntitlement> | null;
  /** App resume listener handle; null when refreshOnResume is disabled, on
   *  web, or when @capacitor/app isn't installed. */
  resumeListener: AppResumeListenerHandle | null;
  emitter: TypedEventEmitter<TEntitlement>;
  logger: Logger;
  initialized: boolean;
  destroyed: boolean;
  entitlements: TEntitlement[];
  /** Timestamp of the last cache write, used for TTL-based background refresh. */
  cachedAt: number | null;
  /**
   * Resolved SKU manifest. Populated in `initialize()` from either the
   * static `config.products` or `backend.listProducts()`. Read by
   * `getProducts()`, `purchase()`, and the orchestrators.
   */
  products: ConfiguredProduct[];
}

export function createIAP<TEntitlement extends EntitlementBase = EntitlementBase>(
  input: IAPConfigInput,
): IAP<TEntitlement> {
  const config = parseConfig(input);
  const logger = resolveLogger(config.options.logLevel, config.options.logger);
  const storage = selectStorageAdapter(config.storage);
  const cache = new EntitlementCache<TEntitlement>(storage, logger);
  const unfinished = new UnfinishedTransactionsStore(storage, logger);
  const backend = selectBackendAdapter<TEntitlement>({ config: config.backend, logger });
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
    orchestrator: null,
    restorer: null,
    recoverer: null,
    resumeListener: null,
    emitter,
    logger,
    initialized: false,
    destroyed: false,
    entitlements: [],
    cachedAt: null,
    products: Object.freeze([...(config.products ?? [])]) as ConfiguredProduct[],
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

      // Resolve the SKU manifest. If the consumer omitted `products` from
      // config, the schema's superRefine has already guaranteed that the
      // backend can supply one — call listProducts() and validate the
      // response against the same schema config-time `products` would have
      // gone through. Failures throw verbatim (the adapter is responsible
      // for mapping transport errors to IAPError).
      if (!state.config.products) {
        if (typeof state.backend.listProducts !== 'function') {
          throw new IAPError({
            code: IAPErrorCode.INVALID_CONFIG,
            message:
              'config.products is omitted but backend adapter does not implement listProducts(). This is a library bug; the schema should have caught it.',
          });
        }
        const fetched = await state.backend.listProducts();
        // Redundant validation on the HTTP path (HttpBackendAdapter already
        // parses with productManifestResponseSchema), but the only validation
        // gate for custom adapters that don't go through HttpClient.
        const validated = configuredProductsArraySchema.safeParse(fetched);
        if (!validated.success) {
          throw new IAPError({
            code: IAPErrorCode.BACKEND_BAD_RESPONSE,
            message: `backend.listProducts() returned an invalid manifest: ${validated.error.issues
              .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
              .join('; ')}`,
            cause: validated.error,
          });
        }
        ensureUniqueProductIds(validated.data);
        state.products = Object.freeze([...validated.data]) as ConfiguredProduct[];
        state.logger.debug(`Resolved ${validated.data.length} product(s) from backend manifest.`);
      }

      // Lazy adapter construction — this is the dynamic-import boundary so
      // web builds don't pull in `@capgo/native-purchases`.
      state.adapter = await selectNativeAdapter();

      // Now that the native adapter is resolved, wire the orchestrators.
      // Both share the same getter/setter triplet into createIAP's state.
      // The HTTP-config `getAuthHeaders` is hoisted here so the purchase
      // orchestrator can forward it to function-form `appUserId` fetchers
      // as `ctx.authHeaders`. Custom-adapter consumers don't have one
      // configured at the IAP-config level, so we resolve to `{}` for
      // them (their fetcher closes over their own auth state).
      const configGetAuthHeaders = state.config.backend.getAuthHeaders;
      const getAuthHeaders: () => Promise<Record<string, string>> = configGetAuthHeaders
        ? async () => configGetAuthHeaders()
        : async () => ({});
      const sharedDeps = {
        nativeAdapter: state.adapter,
        backend: state.backend,
        cache: state.cache,
        unfinished: state.unfinished,
        emitter: state.emitter,
        logger: state.logger,
        getCurrentEntitlements: () => state.entitlements,
        setEntitlements: (next: TEntitlement[]) => {
          state.entitlements = freezeAll(next);
        },
        setCachePersisted: (cachedAt: number) => {
          state.cachedAt = cachedAt;
        },
        getAuthHeaders,
      };

      state.orchestrator = new PurchaseOrchestrator<TEntitlement>({
        ...sharedDeps,
        products: state.products,
      });
      state.restorer = new RestoreOrchestrator<TEntitlement>(sharedDeps);
      state.recoverer = new RecoveryOrchestrator<TEntitlement>({
        ...sharedDeps,
        maxBatch: state.config.options.recoveryMaxBatch,
        permanentErrorCodes: new Set(
          state.config.options.permanentErrorCodes ?? DEFAULT_PERMANENT_ERROR_CODES,
        ),
      });

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

      // Run recovery for unfinished transactions. Best-effort, never throws.
      // Successful recoveries update entitlements before `ready` fires so
      // the consumer's first read sees the latest state.
      if (state.config.options.recoverUnfinishedTransactions && isNative()) {
        try {
          const result = await state.recoverer.recoverUnfinishedTransactions();
          if (result.inspected > 0) {
            state.logger.info(
              `Recovery inspected ${result.inspected} unfinished transaction(s): ${result.recovered} recovered, ${result.failures} retained.`,
            );
          }
        } catch (error) {
          // Recovery should swallow internally; this catches the
          // unexpected case where it didn't.
          state.logger.warn('Recovery threw unexpectedly; continuing initialize.', error);
        }
      }

      // Wire the app-resume listener. Lazy-imports @capacitor/app so consumers
      // who disable refreshOnResume aren't forced to install it.
      if (state.config.options.refreshOnResume && isNative()) {
        state.resumeListener = await attachAppResumeListener({
          logger: state.logger,
          onResume: async () => {
            // Best-effort: warn-and-swallow so a transient backend hiccup
            // doesn't poison subsequent foreground events.
            try {
              await this.refresh();
            } catch (error) {
              state.logger.warn('refreshOnResume: refresh() failed.', error);
            }
          },
        });
      }

      // TTL-based stale-cache check: if we loaded cached entitlements that
      // are older than the configured TTL, schedule a background refresh
      // to fire after `ready`. Reads still return the cached value
      // immediately — PLAN.md §7 "still returns the cached value but the
      // library schedules a refresh".
      if (
        state.cachedAt !== null &&
        Date.now() - state.cachedAt > state.config.options.entitlementCacheTtlMs
      ) {
        state.logger.debug('Cache exceeds TTL; scheduling background refresh.');
        queueMicrotask(() => {
          // Guard against destroy()-during-init: if the consumer tore down
          // before the microtask drained, refresh() would throw NOT_INITIALIZED
          // and emit a confusing warn. Quietly skip instead.
          if (!state.initialized || state.destroyed) return;
          this.refresh().catch((error) => {
            state.logger.warn('TTL background refresh failed.', error);
          });
        });
      }

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
    },

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
      return state.adapter.getProducts(state.products.map((p) => ({ id: p.id, type: p.type })));
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

function ensureUniqueProductIds(products: ConfiguredProduct[]): void {
  const seen = new Set<string>();
  for (const product of products) {
    if (seen.has(product.id)) {
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message: `Duplicate product id "${product.id}" in product manifest.`,
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
