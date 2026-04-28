import type { BackendAdapter, VerifyResponse } from '../adapters/backend/types.js';
import { IAPError, IAPErrorCode } from '../lib/errors.js';
import type { EntitlementBase } from '../types/entitlement.js';
import type { NativeTransaction } from '../types/transaction.js';

/**
 * Route a native transaction to the right per-platform verify endpoint.
 *
 * - Apple → `backend.verifyApple({ productId, transactionId, type })`
 * - Google → `backend.verifyGoogle({ productId, purchaseToken, packageName, type })`
 *
 * Throws `IAPError(STORE_ERROR)` if a Google transaction is missing a
 * `packageName` (the verify request body cannot be built without it).
 *
 * Used by the purchase orchestrator and the recovery orchestrator;
 * restore uses `backend.restore()` (batched, different shape).
 */
export async function verifyNativeTransaction<TEntitlement extends EntitlementBase>(
  backend: BackendAdapter<TEntitlement>,
  tx: NativeTransaction,
): Promise<VerifyResponse<TEntitlement>> {
  if (tx.platform === 'apple') {
    return backend.verifyApple({
      productId: tx.productId,
      transactionId: tx.token,
      type: tx.productType,
    });
  }
  if (!tx.packageName) {
    throw new IAPError({
      code: IAPErrorCode.STORE_ERROR,
      message: `Google transaction for "${tx.productId}" has no packageName; cannot verify.`,
    });
  }
  return backend.verifyGoogle({
    productId: tx.productId,
    purchaseToken: tx.token,
    packageName: tx.packageName,
    type: tx.productType,
  });
}
