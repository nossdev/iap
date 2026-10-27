import type { EntitlementBase } from '../types/entitlement.js';
import { activeEntitlements } from './entitlement-cache.js';
import type { IAPInternalState } from './iap-state.js';

/**
 * Erase everything iap has stored on this device.
 *
 * See `IAP.reset()` for what this is and is not — in particular that it is
 * neither `destroy()` nor a revocation.
 */
export async function resetIap<TEntitlement extends EntitlementBase>(
  state: IAPInternalState<TEntitlement>,
): Promise<void> {
  const previous = state.entitlements;
  state.entitlements = [];
  state.cachedAt = null;

  // Each store swallows its own storage failures, so no try/catch here
  // would ever fire — they are the three keys iap owns, cleared by name
  // because the Preferences adapter can only remove keys it has seen
  // this session (an empty set on a fresh launch).
  await state.cache.clear();
  await state.unfinished.clear();
  await state.pending.clear();

  // Then the namespace itself, for anything an older version wrote that
  // the three stores no longer know about. This one *can* throw.
  try {
    await state.storage.clear();
  } catch (error) {
    state.logger.warn('reset(): failed to clear the storage namespace.', error);
  }

  // The real previous list, not an empty one: a consumer diffing
  // `previous` against `entitlements` is the documented use, and on the
  // one event that removes everything an empty `previous` would read as
  // "nothing changed". Skipped entirely when there was nothing to
  // remove, which is the emitter's de-duplication rule elsewhere.
  if (previous.length > 0) {
    state.emitter.emit('entitlements-changed', { entitlements: [], previous });
  }
}

/**
 * The entitlements that are still active right now.
 *
 * Applied at the read boundary rather than when the cache is written,
 * because expiry is a function of *when you ask*: an entitlement cached as
 * valid at 23:59 is not valid at 00:01, with no refresh in between and no
 * network to ask. Filtering on write would hand out a stale answer for the
 * rest of the session.
 */
export function activeNow<TEntitlement extends EntitlementBase>(
  state: IAPInternalState<TEntitlement>,
): TEntitlement[] {
  // Local mode only, deliberately.
  //
  // With a backend, the backend is the authority on what is granted, and it
  // may return an entitlement whose `expiresAt` has passed on purpose —
  // that is exactly what a store-side grace period or billing retry looks
  // like. Second-guessing it against the device clock would have iap
  // perform the downgrade it promises never to, and a device with a fast
  // clock would lock out a paying user even with the backend reachable.
  //
  // With no backend there is no other authority, and the deadline is the
  // only thing that can revoke anything — so enforcing it locally is the
  // whole point. A consumer who wants this in backend mode can filter on
  // `expiresAt` themselves; `getEntitlementsVerifiedAt()` is there for it.
  if (!state.config.verification) return [...state.entitlements];

  return activeEntitlements(
    state.entitlements,
    Date.now(),
    state.config.options.entitlementGraceMs,
  );
}
