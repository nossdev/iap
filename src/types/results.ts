import type { IAPError } from '../lib/errors.js';
import type { EntitlementBase } from './entitlement.js';
import type { VerifiedTransaction } from './transaction.js';

export type PurchaseResult<TEntitlement extends EntitlementBase = EntitlementBase> =
  | {
      status: 'success';
      productId: string;
      transaction: VerifiedTransaction;
      entitlements: TEntitlement[];
    }
  | { status: 'cancelled'; productId: string }
  | { status: 'pending'; productId: string }
  | { status: 'verification_failed'; productId: string; error: IAPError }
  | { status: 'failed'; productId: string; error: IAPError };

export interface RestoreResult<TEntitlement extends EntitlementBase = EntitlementBase> {
  restored: number;
  entitlements: TEntitlement[];
}
