import { selectNativeAdapter } from '../adapters/native/index.js';
import { IAPError, IAPErrorCode } from '../lib/errors.js';
import { getPlatform, isNative } from '../lib/platform.js';
import { configuredProductsArraySchema } from '../types/config.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { ConfiguredProduct } from '../types/product.js';
import { attachAppResumeListener } from './app-resume-listener.js';
import { attachTransactionWatch } from './attach-transaction-watch.js';
import { type IAPInternalState, ensureUniqueProductIds, freezeAll } from './iap-state.js';
import { PurchaseOrchestrator } from './purchase-flow.js';
import { DEFAULT_PERMANENT_ERROR_CODES, RecoveryOrchestrator } from './recovery-flow.js';
import { RestoreOrchestrator } from './restore-flow.js';
import { TransactionUpdateOrchestrator } from './transaction-updates.js';

/**
 * Bring an instance up: resolve the manifest, construct the native adapter
 * and the orchestrators, load the cache, run recovery, subscribe to the
 * transaction feed, and fire `ready`.
 *
 * Extracted from the factory because every lifecycle feature added a step
 * here and the function had reached 220-odd lines — four times the
 * project's guideline, and the place where the subtlest ordering lives.
 *
 * @param refreshEntitlements the factory's own refresh, which the resume
 *   listener and the TTL microtask call. Passed in rather than reached
 *   through the state bag so it cannot be confused with the public method.
 */
export async function initializeIap<TEntitlement extends EntitlementBase>(
  state: IAPInternalState<TEntitlement>,
  refreshEntitlements: () => Promise<void>,
): Promise<void> {
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
    state.logger.info('Native purchases unavailable on web; entitlement queries still functional.');
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
  state.adapter = await selectNativeAdapter(state.logger, state.config.android.packageName);

  // Now that the native adapter is resolved, wire the orchestrators.
  // Both share the same getter/setter triplet into createIAP's state.
  // The HTTP-config `getAuthHeaders` is hoisted here so the purchase
  // orchestrator can forward it to function-form `appUserId` fetchers
  // as `ctx.authHeaders`. Custom-adapter consumers don't have one
  // configured at the IAP-config level, so we resolve to `{}` for
  // them (their fetcher closes over their own auth state).
  const configGetAuthHeaders = state.config.backend?.getAuthHeaders;
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
    pending: state.pending,
  });
  state.restorer = new RestoreOrchestrator<TEntitlement>(sharedDeps);
  state.recoverer = new RecoveryOrchestrator<TEntitlement>({
    ...sharedDeps,
    pending: state.pending,
    maxBatch: state.config.options.recoveryMaxBatch,
    permanentErrorCodes: new Set(
      state.config.options.permanentErrorCodes ?? DEFAULT_PERMANENT_ERROR_CODES,
    ),
  });

  state.updates = new TransactionUpdateOrchestrator<TEntitlement>({
    nativeAdapter: state.adapter,
    recoverer: state.recoverer,
    pending: state.pending,
    emitter: state.emitter,
    logger: state.logger,
    isPurchaseInFlight: (productId) => state.orchestrator?.isInFlight(productId) ?? false,
    isActive: () => state.initialized && !state.destroyed,
  });

  // Android cannot build a verify or restore request without it, and
  // the failure would otherwise surface per-purchase as a STORE_ERROR
  // long after startup.
  if (platform === 'android' && !state.config.android.packageName) {
    state.logger.warn(
      "config.android.packageName is not set. Google verification and restore requests cannot be built without it, so purchases will fail with STORE_ERROR. Set it to your app's applicationId.",
    );
  }

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

  // Subscribe to the native transaction feed, and close out any pending
  // purchase that resolved while the app was closed. Both are native-only
  // and best-effort: a failure here costs latency (the next resume picks
  // it up), never correctness.
  if (isNative()) {
    state.txWatch = await attachTransactionWatch({
      adapter: state.adapter,
      updates: state.updates,
      logger: state.logger,
    });
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
          await refreshEntitlements();
        } catch (error) {
          state.logger.warn('refreshOnResume: refresh() failed.', error);
        }
        // Returning from the store's own payment UI is exactly when a
        // pending purchase has most likely resolved. `reconcilePending`
        // no-ops when nothing is pending, so this costs nothing in the
        // common case and never throws.
        await state.updates?.reconcilePending();
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
      refreshEntitlements().catch((error) => {
        state.logger.warn('TTL background refresh failed.', error);
      });
    });
  }

  state.initialized = true;
  state.emitter.emit('ready', undefined);

  // Close out pending purchases after `ready`, not before it.
  //
  // Reconciliation can mean a store round-trip plus a backend verify,
  // and unlike recovery above it has no batch cap — so awaiting it
  // inside initialize() would delay every consumer's first render by
  // however long that takes. It is safe to run late: the purchase
  // already resolved in the store, nothing is lost by learning a moment
  // later, and `reconcilePending` no-ops when nothing is marked.
  if (isNative()) {
    queueMicrotask(() => {
      if (!state.initialized || state.destroyed) return;
      void state.updates?.reconcilePending();
    });
  }
}
