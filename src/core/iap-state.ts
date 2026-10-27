import type { BackendAdapter } from '../adapters/backend/types.js';
import type { NativeAdapter, TransactionWatchHandle } from '../adapters/native/types.js';
import type { StorageAdapter } from '../adapters/storage/types.js';
import type { TypedEventEmitter } from '../events/emitter.js';
import { IAPError, IAPErrorCode } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { IAPConfig } from '../types/config.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { ConfiguredProduct } from '../types/product.js';
import type { AppResumeListenerHandle } from './app-resume-listener.js';
import type { EntitlementCache } from './entitlement-cache.js';
import type { PendingPurchasesStore } from './pending-purchases.js';
import type { PurchaseOrchestrator } from './purchase-flow.js';
import type { RecoveryOrchestrator } from './recovery-flow.js';
import type { RestoreOrchestrator } from './restore-flow.js';
import type { TransactionUpdateOrchestrator } from './transaction-updates.js';
import type { UnfinishedTransactionsStore } from './unfinished-transactions.js';

/**
 * The mutable state one `createIAP()` instance owns.
 *
 * Passed around as a bag rather than captured in the factory's closure, so
 * the lifecycle steps can live in their own modules instead of accumulating
 * inside one 200-line function. Every lifecycle feature so far landed in
 * `initialize()`; this is what stops the next one from doing the same.
 */
export interface IAPInternalState<TEntitlement extends EntitlementBase> {
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
  pending: PendingPurchasesStore;
  /** Constructed lazily in initialize() once the native adapter is resolved. */
  orchestrator: PurchaseOrchestrator<TEntitlement> | null;
  /** Constructed alongside the orchestrator in initialize(). */
  restorer: RestoreOrchestrator<TEntitlement> | null;
  /** Constructed alongside the orchestrator; recovery runs once at init. */
  recoverer: RecoveryOrchestrator<TEntitlement> | null;
  /** Handles transactions arriving outside a purchase, and pending resolution. */
  updates: TransactionUpdateOrchestrator<TEntitlement> | null;
  /** Native transaction-feed listener; null when the platform has none. */
  txWatch: TransactionWatchHandle | null;
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

export function freezeAll<T extends object>(items: T[]): T[] {
  return items.map((item) => Object.freeze({ ...item }));
}

export function ensureUniqueProductIds(products: ConfiguredProduct[]): void {
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

export function requireInitialized<TEntitlement extends EntitlementBase>(
  state: IAPInternalState<TEntitlement>,
): void {
  if (!state.initialized) {
    throw new IAPError({
      code: IAPErrorCode.NOT_INITIALIZED,
      message: 'Call iap.initialize() before this method.',
    });
  }
}
