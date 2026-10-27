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
  return new IAPError({
    code: IAPErrorCode.STORE_ERROR,
    message: `Native purchase of "${productId}" failed.`,
    cause: error,
  });
}
