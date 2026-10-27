import type { IAPError } from '../lib/errors.js';
import type { EntitlementBase } from './entitlement.js';
import type { StorePurchase } from './results.js';
import type { VerifiedTransaction } from './transaction.js';

/**
 * Map of event name → payload. Used by the typed event emitter so consumer
 * subscriptions are statically checked.
 */
export interface EventMap<TEntitlement extends EntitlementBase = EntitlementBase> {
  ready: undefined;
  'purchase-started': { productId: string };
  'purchase-success': { productId: string; transaction: VerifiedTransaction };
  'purchase-cancelled': { productId: string };
  'purchase-pending': { productId: string };
  /**
   * A purchase previously reported as `purchase-pending` has resolved.
   *
   * `purchased` means it cleared and the entitlement is in place (the
   * transaction has been verified and acknowledged by the time this fires).
   * `cancelled` means the store no longer has it, either waiting or owned —
   * the payment failed, expired, or the user abandoned it.
   *
   * **`cancelled` only fires where the platform can distinguish "gone" from
   * "still waiting"** — Android, via Play's purchase state. On iOS a
   * deferred purchase that is never approved produces no signal at all, so
   * iap says nothing rather than guessing; the pending mark simply stays
   * until a transaction arrives.
   *
   * Fires at most once per pending purchase. Use it to clear
   * pending-state copy a paywall put up on `purchase-pending`.
   */
  'purchase-pending-resolved': { productId: string; status: 'purchased' | 'cancelled' };
  /**
   * A transaction arrived outside a `purchase()` call — a renewal, a refund
   * or revocation, an Ask-to-Buy approval, a pending purchase clearing.
   *
   * Fires before iap has verified it, so treat the payload as "the store
   * says something happened", not as an entitlement change. The
   * authoritative signal is `entitlements-changed`, which follows if the
   * backend confirms it.
   *
   * iOS only in practice: the native layer feeds this from Apple's
   * `Transaction.updates` and has no Android equivalent, where the same
   * ground is covered by reconciliation at launch and on resume.
   */
  'transaction-updated': { productId: string; purchase: StorePurchase };
  'purchase-failed': { productId: string; error: IAPError };
  'verification-failed': { productId: string; error: IAPError };
  'restore-started': undefined;
  'restore-completed': { restored: number; entitlements: TEntitlement[] };
  'entitlements-changed': { entitlements: TEntitlement[]; previous: TEntitlement[] };
  /**
   * Recovery classified an `unfinished_transactions` entry as permanently
   * invalid (per `options.permanentErrorCodes`) and removed it from
   * storage. Will not be retried on subsequent launches. Useful for ops
   * logging / alerting on stuck-loop self-heal events.
   *
   * **Token is unmasked.** Receipt tokens (Apple `transactionId` /
   * Google `purchaseToken`) are useful for correlation in debugging
   * but are receipts you don't want to leak — treat as sensitive. Mask
   * before forwarding to external analytics / logging services. iap's
   * own internal logs use a masked form (see `lib/redact.ts`).
   */
  'recovery-dropped-permanent': {
    productId: string;
    token: string;
    error: string;
    message?: string;
  };
}

export type EventName<TEntitlement extends EntitlementBase = EntitlementBase> =
  keyof EventMap<TEntitlement>;

export type EventPayload<
  K extends EventName<TEntitlement>,
  TEntitlement extends EntitlementBase = EntitlementBase,
> = EventMap<TEntitlement>[K];

export type Unsubscribe = () => void;
