import { IAPError, IAPErrorCode } from '../../../lib/errors.js';

/**
 * Translate a `purchaseProduct()` rejection into a coded {@link IAPError} so
 * the purchase orchestrator can route it to the right `PurchaseResult` status.
 *
 * `@capgo/native-purchases` rejects with plain message strings — the
 * signals we can distinguish (verified against the plugin's native source):
 * - iOS: `"User cancelled"`, `"Transaction pending"`,
 *   `"Cannot find product for id <id>"`.
 * - Android: `"Purchase is pending"`, `"Product not found"`. Note Android
 *   does NOT distinguish user-cancel from other billing errors — both
 *   surface as `"Purchase is not purchased"`, which falls through to
 *   `STORE_ERROR`. The error-handling docs note this asymmetry for
 *   consumer UX (treat Android `failed` similarly to `cancelled`).
 */
export function mapPurchaseError(error: unknown, productId: string): IAPError {
  if (error instanceof IAPError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('cancel')) {
    return new IAPError({
      code: IAPErrorCode.USER_CANCELLED,
      message: `Purchase of "${productId}" was cancelled.`,
      cause: error,
    });
  }
  if (lower.includes('pending')) {
    return new IAPError({
      code: IAPErrorCode.PURCHASE_PENDING,
      message: `Purchase of "${productId}" is pending external clearance.`,
      cause: error,
    });
  }
  // iOS uses `"Cannot find product for id <id>"`; Android uses
  // `"Product not found"`. Match both shapes.
  if (lower.includes('product not found') || lower.includes('cannot find product')) {
    return new IAPError({
      code: IAPErrorCode.PRODUCT_NOT_FOUND,
      message: `Product "${productId}" was not found in the store catalog.`,
      cause: error,
    });
  }
  // Reachable only because iap now sends an offer token. The plugin
  // validates it against the live product query and rejects an unknown one
  // — which is the right behaviour, but it is a stale-input problem, not a
  // store problem, and falling through to STORE_ERROR would have told the
  // developer to "check device connectivity".
  //
  // Checked after `product not found` on purpose: the plugin's message is
  // "Offer token not found for product: <id>", which contains neither of
  // that branch's phrases, but ordering it here keeps the more specific
  // match from depending on that.
  if (lower.includes('offer token not found')) {
    return new IAPError({
      code: IAPErrorCode.INVALID_PURCHASE_OPTIONS,
      message: `The androidOfferToken passed for "${productId}" matches no current offer. These are per-query device tokens: re-read Product.androidOneTimeOffers from a fresh getProducts() rather than persisting one.`,
      cause: error,
    });
  }
  return new IAPError({
    code: IAPErrorCode.STORE_ERROR,
    message: `Native purchase of "${productId}" failed.`,
    cause: error,
  });
}
