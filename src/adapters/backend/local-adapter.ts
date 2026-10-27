import { z } from 'zod';
import { verifyPurchaseOnDevice } from '../../core/local-verification.js';
import type {
  LocalVerificationOptions,
  LocallyVerifiedPurchase,
} from '../../core/local-verification.js';
import { IAPError, IAPErrorCode } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { entitlementBaseSchema } from '../../types/entitlement.js';
import type { EntitlementBase } from '../../types/entitlement.js';
import type { ConfiguredProduct } from '../../types/product.js';
import type { NativeTransaction } from '../../types/transaction.js';
import type { NativeAdapter } from '../native/types.js';
import type { BackendAdapter, RestoreRequest, RestoreResponse, VerifyResponse } from './types.js';

export interface LocalVerificationAdapterOptions<TEntitlement extends EntitlementBase> {
  /**
   * Resolved lazily: the native adapter is constructed in `initialize()`,
   * after this adapter, and is needed to read what the store owns.
   */
  getNativeAdapter: () => NativeAdapter | null;
  getProducts: () => readonly ConfiguredProduct[];
  /** Maps a verified purchase to the entitlements it grants. */
  entitlements: (purchase: LocallyVerifiedPurchase) => TEntitlement[];
  /** The binding every purchase must carry, when the app uses one. */
  getAppUserId?: () => string | null;
  /**
   * The entitlements currently held, so an ambiguous answer from the store
   * can preserve them rather than wipe them. See {@link getEntitlements}.
   */
  getCurrentEntitlements: () => TEntitlement[];
  graceMs: number;
  logger: Logger;
}

/**
 * Verifies purchases on the device, with no backend.
 *
 * Implemented as a `BackendAdapter` on purpose. iap's safety guarantees —
 * persist before verifying, acknowledge only after verification succeeds,
 * retry anything unfinished on the next launch — all live in the purchase
 * and recovery flows, above this interface. Making local mode an adapter
 * means those flows are **untouched** by it: there is no second purchase
 * path to keep in step, and the no-backend case gets exactly the same
 * crash-safety as the backend case.
 *
 * It is not a stub or a bypass. Every verification still happens, still
 * gates acknowledgement, and can still fail — it is just answered on the
 * device instead of over the network.
 *
 * **What the device cannot do**, and what the docs say plainly: check Play's
 * purchase signature (the native layer does not expose it), detect a refund
 * Apple has not yet reflected in the local receipt, or resist a device whose
 * clock or store client is lying. A purchase's
 * {@link LocallyVerifiedPurchase.assurance} records which of the two
 * strengths it got. If being wrong is expensive, use a backend.
 */
export class LocalVerificationAdapter<TEntitlement extends EntitlementBase = EntitlementBase>
  implements BackendAdapter<TEntitlement>
{
  constructor(private readonly opts: LocalVerificationAdapterOptions<TEntitlement>) {}

  /**
   * The whole transaction, not the extracted fields the HTTP contract sends.
   *
   * A local check needs the binding, the subscription state and the expiry,
   * and `VerifyAppleRequest` carries none of them — it is shaped for what a
   * server needs to look a receipt up. The router prefers this method when
   * an adapter has it, so the HTTP path is unaffected.
   */
  async verifyNative(transaction: NativeTransaction): Promise<VerifyResponse<TEntitlement>> {
    const checked = this.check(transaction);
    if (!checked.valid) return checked;

    // Return the **consolidated** set, not just this purchase's.
    //
    // The flows treat `VerifyResponse.entitlements` as the whole truth and
    // replace state with it, which is what a backend returns. Returning one
    // purchase's worth here silently revoked everything else: buying a
    // consumable wiped a subscription, in memory and on disk, until the next
    // refresh.
    //
    // The store may not report the just-bought purchase yet, so it is merged
    // in explicitly rather than relied upon.
    return {
      valid: true,
      entitlements: await this.consolidated(checked.purchase),
      transaction: checked.transaction,
    };
  }

  /**
   * Unreachable in practice: the router prefers {@link verifyNative}. Kept
   * because `BackendAdapter` requires them, and failing loudly is better
   * than silently granting if a future caller bypasses the router.
   */
  async verifyApple(): Promise<VerifyResponse<TEntitlement>> {
    throw this.unsupported('verifyApple');
  }

  async verifyGoogle(): Promise<VerifyResponse<TEntitlement>> {
    throw this.unsupported('verifyGoogle');
  }

  /**
   * In local mode the store **is** the source of truth, so a refresh asks
   * it what it owns and re-derives entitlements from that.
   *
   * This is why `refreshOnResume` keeps working with no network: there is
   * nothing to reach. A purchase that expired while the app was backgrounded
   * drops out here, which is the only downgrade local mode performs.
   */
  async getEntitlements(): Promise<TEntitlement[]> {
    const owned = await this.ownedTransactions();

    // An empty answer is ambiguous, and must not downgrade anyone.
    //
    // Play resolves `getPurchases()` with an empty array when the query
    // *fails* — a disconnected billing service, a signed-out account, a
    // non-OK response code — rather than rejecting. So "owns nothing" and
    // "could not tell you" look identical, and treating the first as
    // authoritative would wipe a paying user's entitlements on a transient
    // store error, which is exactly what the offline guarantee forbids.
    //
    // `restorePurchases()` has always guarded this; `refresh()` did not,
    // and `refreshOnResume` calls it on every foreground.
    if (owned.length === 0) {
      const current = this.opts.getCurrentEntitlements();
      if (current.length > 0) {
        this.opts.logger.debug(
          'The store reported nothing owned. Keeping the current entitlements, since an empty answer is indistinguishable from a failed query.',
        );
      }
      return current;
    }

    return this.consolidated();
  }

  /**
   * Restore is the same question as a refresh here — "what does this store
   * account own" — answered from the transactions the orchestrator already
   * read, so the store is not asked twice.
   */
  async restoreNative(owned: NativeTransaction[]): Promise<RestoreResponse<TEntitlement>> {
    const { entitlements, verifiedTokens } = this.evaluate(owned);

    // `verifiedTokens` is what keeps the acknowledge-after-verification
    // invariant true on this path. Without it the orchestrator reads only
    // the top-level `valid` and acknowledges **every** owned transaction —
    // including ones this check refused, which on Android finalises the
    // purchase and waives Play's refund window for something just declared
    // invalid.
    if (verifiedTokens.length === 0) {
      return {
        valid: false,
        error: 'NO_VERIFIED_PURCHASES',
        message: 'The store reported purchases, but none passed the on-device checks.',
      };
    }

    return { valid: true, entitlements, verifiedTokens };
  }

  /**
   * Unreachable via the orchestrator, which prefers {@link restoreNative}.
   * Kept so the adapter satisfies a consumer holding it as a plain
   * `BackendAdapter`; it re-reads the store rather than trusting an
   * extracted request a local check cannot verify from.
   */
  async restore(_req: RestoreRequest): Promise<RestoreResponse<TEntitlement>> {
    return this.restoreNative(await this.ownedTransactions());
  }

  private checkOptions(): LocalVerificationOptions {
    return {
      productIds: this.opts.getProducts().map((p) => p.id),
      appUserId: this.opts.getAppUserId?.() ?? null,
      graceMs: this.opts.graceMs,
    };
  }

  private check(transaction: NativeTransaction):
    | { valid: false; error: string; message: string }
    | {
        valid: true;
        purchase: LocallyVerifiedPurchase;
        transaction: { id: string; productId: string; expiresAt: string | null };
      } {
    const result = verifyPurchaseOnDevice(transaction, this.checkOptions());

    if (!result.valid) {
      this.opts.logger.debug(
        `Local verification refused "${transaction.productId}": ${result.error}.`,
      );
      return { valid: false, error: result.error, message: result.message };
    }

    return {
      valid: true,
      purchase: result.purchase,
      transaction: {
        // The purchase's own identity, not a server-assigned id — there is
        // no server to assign one. Note it is stable across renewals, so it
        // is not a per-transaction key.
        id: result.purchase.purchaseReference,
        productId: result.purchase.productId,
        expiresAt: result.purchase.expiresAt,
      },
    };
  }

  /**
   * Run the consumer's mapper and validate what it returns.
   *
   * Unlike a backend response, this value never went through a schema — it
   * comes straight from consumer code into iap's state and cache. An
   * unvalidated mapper could cache an object with no `key` (so
   * `hasEntitlement` could never match it, and the next launch would drop it
   * from the cache, making entitlements differ between sessions), or return
   * a non-array and throw a raw `TypeError` out of `purchase()` *after* the
   * transaction was acknowledged.
   */
  private map(purchase: LocallyVerifiedPurchase): TEntitlement[] {
    let mapped: unknown;
    try {
      mapped = this.opts.entitlements(purchase);
    } catch (error) {
      this.opts.logger.warn(
        `verification.entitlements threw for "${purchase.productId}"; granting nothing for it.`,
        error,
      );
      return [];
    }

    const parsed = z.array(entitlementBaseSchema.passthrough()).safeParse(mapped);
    if (!parsed.success) {
      this.opts.logger.warn(
        `verification.entitlements returned something that is not a list of entitlements for "${purchase.productId}"; granting nothing for it. Each entry needs a key, a productId and an expiresAt (which may be null).`,
      );
      return [];
    }

    return parsed.data as TEntitlement[];
  }

  /** The consolidated entitlements, optionally merging a just-verified purchase. */
  private async consolidated(extra?: LocallyVerifiedPurchase): Promise<TEntitlement[]> {
    const owned = await this.ownedTransactions();
    const { entitlements } = this.evaluate(owned, extra);
    return entitlements;
  }

  /**
   * Evaluate an owned set: which transactions passed, and what they grant.
   *
   * Returns the tokens that passed as well as the entitlements, because the
   * caller needs to know *which* transactions may be acknowledged — a
   * single consolidated list cannot say.
   */
  private evaluate(
    owned: NativeTransaction[],
    extra?: LocallyVerifiedPurchase,
  ): { entitlements: TEntitlement[]; verifiedTokens: string[] } {
    const verifiedTokens: string[] = [];
    const byKey = new Map<string, TEntitlement>();

    const absorb = (purchase: LocallyVerifiedPurchase): void => {
      for (const entitlement of this.map(purchase)) {
        const existing = byKey.get(entitlement.key);
        // iOS reports historical transactions alongside current ones, so one
        // key is derived several times. Keep the one that lasts longest —
        // keeping the first would discard the live renewal's entitlement in
        // favour of an older one still inside the grace window, and the
        // user's access would then lapse while the subscription was valid.
        if (!existing || outlasts(entitlement.expiresAt, existing.expiresAt)) {
          byKey.set(entitlement.key, entitlement);
        }
      }
    };

    for (const transaction of owned) {
      const result = verifyPurchaseOnDevice(transaction, this.checkOptions());
      if (!result.valid) {
        this.opts.logger.debug(
          `Local verification refused "${transaction.productId}": ${result.error}.`,
        );
        continue;
      }
      verifiedTokens.push(transaction.token);
      absorb(result.purchase);
    }

    if (extra) absorb(extra);

    return { entitlements: [...byKey.values()], verifiedTokens };
  }

  private async ownedTransactions(): Promise<NativeTransaction[]> {
    const native = this.opts.getNativeAdapter();
    if (!native) {
      throw new IAPError({
        code: IAPErrorCode.NOT_INITIALIZED,
        message: 'Local verification needs the native adapter; call iap.initialize() first.',
      });
    }
    return native.getOwnedTransactions();
  }

  private unsupported(method: string): IAPError {
    return new IAPError({
      code: IAPErrorCode.INVALID_CONFIG,
      message: `${method}() cannot verify locally: it receives only the extracted request fields, and an on-device check needs the binding, the subscription state and the expiry. Call verifyNative(transaction) instead — which is what iap's own router does.`,
    });
  }
}

/** Whether `a` lasts longer than `b`; a null expiry outlasts any date. */
function outlasts(a: string | null, b: string | null): boolean {
  if (a === null) return true;
  if (b === null) return false;
  return Date.parse(a) > Date.parse(b);
}
