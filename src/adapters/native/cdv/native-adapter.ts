import 'cordova-plugin-purchase';

import { IAPError, IAPErrorCode } from '../../../lib/errors.js';
import { getPlatform } from '../../../lib/platform.js';
import type { ConfiguredProduct, Product, ProductType } from '../../../types/product.js';
import type { Platform as IAPPlatform, NativeTransaction } from '../../../types/transaction.js';
import type { NativeAdapter, NativePurchaseOptions } from '../types.js';

/**
 * Capacitor 5 adapter built against `cordova-plugin-purchase@^13.x` (CdvPurchase).
 *
 * The plugin is event-driven; this adapter promisifies the parts of its API
 * that we expose through the {@link NativeAdapter} contract.
 *
 * Safety guarantee: `purchaseProduct()` resolves on `.approved()` but does
 * NOT call `tx.finish()`. The finish call is deferred to `acknowledge()`,
 * which the core purchase flow invokes only after the consumer backend
 * has verified the transaction.
 *
 * See `docs/internal/cdv-purchase-api.md` for the captured plugin surface.
 */
export class CdvNativeAdapter implements NativeAdapter {
  private readonly products: ConfiguredProduct[];
  private bootstrapped = false;
  private bootstrapping: Promise<void> | null = null;
  private readonly pendingFinish = new Map<string, CdvPurchase.Transaction>();
  /** Long-lived bootstrap-time .approved() listener — kept for dispose(). */
  private bootstrapApprovedHandler: ((tx: CdvPurchase.Transaction) => void) | null = null;

  constructor(opts: { products: ConfiguredProduct[] }) {
    this.products = opts.products;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.bootstrap();
      return true;
    } catch {
      return false;
    }
  }

  async getProducts(requests: Array<{ id: string; type: ProductType }>): Promise<Product[]> {
    if (requests.length === 0) return [];
    const store = await this.ensureStore();
    await store.update();

    const out: Product[] = [];
    for (const req of requests) {
      const native = store.get(req.id);
      if (!native) continue;
      out.push(normalizeProduct(native, req.type));
    }
    return out;
  }

  async purchaseProduct(opts: NativePurchaseOptions): Promise<NativeTransaction> {
    const store = await this.ensureStore();
    const native = store.get(opts.productId);
    if (!native) {
      throw new IAPError({
        code: IAPErrorCode.PRODUCT_NOT_FOUND,
        message: `Product "${opts.productId}" not registered or not available from the store.`,
      });
    }

    // For multi-plan Android subscriptions (e.g. monthly + yearly under one
    // product) the consumer's androidPlanId selects which offer to order.
    // On iOS the offer id is ignored.
    const offer = opts.androidPlanId
      ? (native.getOffer(opts.androidPlanId) ?? native.getOffer())
      : native.getOffer();
    if (!offer) {
      throw new IAPError({
        code: IAPErrorCode.PRODUCT_NOT_FOUND,
        message: `Product "${opts.productId}" has no purchasable offer${
          opts.androidPlanId ? ` (planId="${opts.androidPlanId}")` : ''
        }.`,
      });
    }

    return new Promise<NativeTransaction>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        store.off(handleApproved);
      };

      const handleApproved = (tx: CdvPurchase.Transaction): void => {
        if (settled) return;
        if (!tx.products.some((p) => p.id === opts.productId)) return;

        const token = transactionToken(tx);
        if (!token) {
          settled = true;
          cleanup();
          reject(
            new IAPError({
              code: IAPErrorCode.STORE_ERROR,
              message: `Approved transaction for "${opts.productId}" has no token; cannot verify.`,
            }),
          );
          return;
        }

        settled = true;
        cleanup();
        const normalized = normalizeTransaction(tx, opts.productType, token);
        this.pendingFinish.set(token, tx);
        resolve(normalized);
      };

      store.when().approved(handleApproved);

      const additionalData = opts.appAccountToken
        ? { applicationUsername: opts.appAccountToken }
        : undefined;

      void Promise.resolve(offer.order(additionalData))
        .then((err) => {
          if (settled) return;
          if (!err) return; // success: wait for .approved()
          settled = true;
          cleanup();
          reject(mapOrderError(err, opts.productId));
        })
        .catch((cause) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new IAPError({
              code: IAPErrorCode.STORE_ERROR,
              message: `order() rejected for ${opts.productId}.`,
              cause,
            }),
          );
        });
    });
  }

  async getOwnedTransactions(): Promise<NativeTransaction[]> {
    const store = await this.ensureStore();
    await store.restorePurchases();

    const out: NativeTransaction[] = [];
    for (const tx of store.localTransactions) {
      if (tx.state !== getCdv().TransactionState.APPROVED) continue;
      const token = transactionToken(tx);
      if (!token) continue; // skip transactions we can't ack — log via caller
      const normalized = normalizeTransaction(tx, inferProductType(tx, this.products), token);
      this.pendingFinish.set(token, tx);
      out.push(normalized);
    }
    return out;
  }

  async acknowledge(transaction: NativeTransaction): Promise<void> {
    const cdvTx = this.pendingFinish.get(transaction.token);
    if (!cdvTx) {
      // Idempotent — already finished, or unknown.
      return;
    }
    try {
      await cdvTx.finish();
    } catch (cause) {
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: `Failed to finish transaction for ${transaction.productId}.`,
        cause,
        recoverable: true,
      });
    }
    this.pendingFinish.delete(transaction.token);
  }

  async manageSubscriptions(): Promise<void> {
    const store = await this.ensureStore();
    const err = await store.manageSubscriptions();
    if (err) {
      throw new IAPError({
        code: IAPErrorCode.STORE_ERROR,
        message: err.message ?? 'Failed to open subscription management.',
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.bootstrapApprovedHandler) {
      try {
        const cdv = (globalThis as { CdvPurchase?: { store?: CdvPurchase.Store } }).CdvPurchase;
        cdv?.store?.off(this.bootstrapApprovedHandler);
      } catch {
        // best-effort
      }
      this.bootstrapApprovedHandler = null;
    }
    this.pendingFinish.clear();
    this.bootstrapped = false;
    this.bootstrapping = null;
  }

  // ----- internals -----

  private async ensureStore(): Promise<CdvPurchase.Store> {
    await this.bootstrap();
    return getCdv().store;
  }

  private bootstrap(): Promise<void> {
    if (this.bootstrapped) return Promise.resolve();
    if (this.bootstrapping) return this.bootstrapping;

    this.bootstrapping = (async () => {
      const cdv = getCdv();
      const platform = currentCdvPlatform();

      cdv.store.register(
        this.products.map((p) => ({
          id: p.id,
          type: mapProductType(p.type),
          platform,
        })),
      );

      const errors = await cdv.store.initialize([platform]);
      if (errors && errors.length > 0) {
        const first = errors[0];
        throw new IAPError({
          code: IAPErrorCode.BILLING_NOT_AVAILABLE,
          message: first?.message ?? 'cordova-plugin-purchase initialize() reported errors.',
        });
      }

      // Long-lived listener so out-of-band approved transactions
      // (StoreKit replays on launch, etc.) are captured for later acknowledge().
      // Stored on `this` so dispose() can remove it.
      const handler = (tx: CdvPurchase.Transaction): void => {
        const token = transactionToken(tx);
        if (!token) return;
        if (!this.pendingFinish.has(token)) {
          this.pendingFinish.set(token, tx);
        }
      };
      this.bootstrapApprovedHandler = handler;
      cdv.store.when().approved(handler);

      await cdv.store.update();
      this.bootstrapped = true;
    })();

    return this.bootstrapping;
  }
}

// ----- helpers (module scope so they're testable in isolation) -----

interface CdvNamespaceShape {
  store: CdvPurchase.Store;
  Platform: typeof CdvPurchase.Platform;
  ProductType: typeof CdvPurchase.ProductType;
  ErrorCode: typeof CdvPurchase.ErrorCode;
  TransactionState: typeof CdvPurchase.TransactionState;
}

function getCdv(): CdvNamespaceShape {
  const candidate = (globalThis as { CdvPurchase?: CdvNamespaceShape }).CdvPurchase;
  if (!candidate || !candidate.store) {
    throw new IAPError({
      code: IAPErrorCode.BILLING_NOT_AVAILABLE,
      message:
        'cordova-plugin-purchase is not available. Ensure the plugin is installed and `npx cap sync` has run.',
    });
  }
  return candidate;
}

function currentCdvPlatform(): CdvPurchase.Platform {
  const cdv = getCdv();
  const platform = getPlatform();
  if (platform === 'android') return cdv.Platform.GOOGLE_PLAY;
  // iOS or web (web shouldn't reach this code, but APPLE_APPSTORE is the safer default).
  return cdv.Platform.APPLE_APPSTORE;
}

function mapProductType(type: ProductType): CdvPurchase.ProductType {
  const cdv = getCdv();
  switch (type) {
    case 'subscription':
      return cdv.ProductType.PAID_SUBSCRIPTION;
    case 'consumable':
      return cdv.ProductType.CONSUMABLE;
    default:
      return cdv.ProductType.NON_CONSUMABLE;
  }
}

function inferProductType(
  tx: CdvPurchase.Transaction,
  configured: ConfiguredProduct[],
): ProductType {
  const id = tx.products[0]?.id;
  if (!id) return 'product';
  const match = configured.find((p) => p.id === id);
  return match?.type ?? 'product';
}

function normalizeProduct(p: CdvPurchase.Product, type: ProductType): Product {
  const offer = p.getOffer();
  const phase = offer?.pricingPhases?.[0];
  const priceMicros = phase?.priceMicros?.toString() ?? '0';
  const priceString = phase?.price ?? '';
  const currency = phase?.currency ?? '';
  return {
    id: p.id,
    type,
    title: p.title ?? p.id,
    description: p.description ?? '',
    priceString,
    priceMicros,
    currency,
  };
}

function normalizeTransaction(
  tx: CdvPurchase.Transaction,
  productType: ProductType,
  token: string,
): NativeTransaction {
  const platform: IAPPlatform = tx.platform === 'ios-appstore' ? 'apple' : 'google';
  const productId = tx.products[0]?.id ?? '';
  return {
    platform,
    productId,
    token,
    productType,
    raw: tx,
  };
}

function transactionToken(tx: CdvPurchase.Transaction): string | null {
  if (tx.platform === 'ios-appstore') {
    return tx.transactionId || null;
  }
  // Google: prefer nativePurchase.purchaseToken, fall back to parentReceipt.purchaseToken
  const googleTx = tx as unknown as {
    nativePurchase?: { purchaseToken?: string };
    parentReceipt?: { purchaseToken?: string };
  };
  return (
    googleTx.nativePurchase?.purchaseToken ??
    googleTx.parentReceipt?.purchaseToken ??
    tx.transactionId ??
    null
  );
}

function mapOrderError(err: CdvPurchase.IError, productId: string): IAPError {
  const cdv = getCdv();
  const cancelled = cdv.ErrorCode?.PAYMENT_CANCELLED;
  if (cancelled !== undefined && err.code === cancelled) {
    return new IAPError({
      code: IAPErrorCode.USER_CANCELLED,
      message: 'User cancelled the native purchase sheet.',
      cause: err,
    });
  }
  return new IAPError({
    code: IAPErrorCode.STORE_ERROR,
    message: err.message ?? `order() failed for ${productId}.`,
    cause: err,
  });
}
