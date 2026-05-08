import type { IAPError } from '../lib/errors.js';
import type { EntitlementBase } from './entitlement.js';
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
  'purchase-failed': { productId: string; error: IAPError };
  'verification-failed': { productId: string; error: IAPError };
  'restore-started': undefined;
  'restore-completed': { restored: number; entitlements: TEntitlement[] };
  'entitlements-changed': { entitlements: TEntitlement[]; previous: TEntitlement[] };
  'price-stale': { productId: string; lastFetchedAt: number };
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
  error: { error: IAPError };
}

export type EventName<TEntitlement extends EntitlementBase = EntitlementBase> =
  keyof EventMap<TEntitlement>;

export type EventPayload<
  K extends EventName<TEntitlement>,
  TEntitlement extends EntitlementBase = EntitlementBase,
> = EventMap<TEntitlement>[K];

export type Unsubscribe = () => void;
