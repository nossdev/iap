import { IAPError, IAPErrorCode } from '../lib/errors.js';
import type { EntitlementBase } from '../types/entitlement.js';
import { activeEntitlements } from './entitlement-cache.js';
import type { IAPInternalState } from './iap-state.js';
import { ALL_IAP_STORAGE_KEYS } from './storage-keys.js';

/**
 * Erase everything iap has stored on this device.
 *
 * See `IAP.reset()` for what this is and is not — in particular that it is
 * neither `destroy()` nor a revocation.
 */
export async function resetIap<TEntitlement extends EntitlementBase>(
  state: IAPInternalState<TEntitlement>,
): Promise<void> {
  // A purchase mid-flight is the one thing worth refusing over, and it is
  // the *unfinished-transaction entry* that makes it so, not the cache.
  // That entry is written before verification precisely so a purchase
  // survives a crash; deleting it mid-flight leaves a purchase neither
  // acknowledged nor tracked, which Play auto-refunds in three days. The
  // cache coming straight back is harmless by comparison — `reset()` was
  // never a revocation, and a `refresh()` re-deriving from the store is
  // documented behaviour.
  //
  // Vacuously true after `destroy()`, which nulls the orchestrator. That
  // is the right answer there: a destroyed instance has nothing left that
  // could re-persist, so it is the *safest* moment to wipe, and a teardown
  // racing a "delete my data" tap is a real sequence. Returning early
  // would leave the cache, the queue and the pending marks on the device
  // while telling the caller their data was gone.
  const inFlight = state.orchestrator?.inFlightProducts() ?? [];
  if (inFlight.length > 0) {
    throw new IAPError({
      code: IAPErrorCode.ALREADY_IN_PROGRESS,
      message: `Cannot reset while a purchase of ${inFlight.map((id) => `"${id}"`).join(', ')} is in progress: its unfinished-transaction record is still needed. Await the purchase, then reset.`,
      // The per-code hint is written for the other caller of this code — a
      // double `purchase()` of one product — and would tell a consumer
      // debugging a failed reset that they double-called `purchase()`.
      includeHint: false,
      // It is recoverable, whatever the code's default says: await the
      // purchase and try again.
      recoverable: true,
    });
  }

  // Fail loudly if the storage backend cannot be reached at all.
  //
  // Every step below is swallow-and-warn, which is right for one key that
  // will not delete — but it also means an adapter that can reach *nothing*
  // resolves this promise normally after logging six warnings and deleting
  // nothing. For a "delete everything" control, telling the caller their
  // data is gone when it is still on the device is the one outcome worth
  // throwing over. `reset()` has no `requireInitialized`, so this is the
  // only place that check happens on this path.
  await state.storage.ensureAvailable?.();

  const previous = state.entitlements;
  state.entitlements = [];
  state.cachedAt = null;

  // Through the stores first, because two of the three serialise their
  // read-modify-write through a mutation lock (`runExclusive`) and this is
  // the only way to take it. A concurrent `pending.add()` that has read but
  // not yet written would otherwise re-persist the whole list after a bare
  // `storage.remove`. Each store swallows its own storage failures.
  await state.cache.clear();
  await state.unfinished.clear();
  await state.pending.clear();

  // Then every key in the registry, by name. This is the completeness
  // half: it catches a store added later whose `clear()` nobody remembered
  // to call above, and it is also the only step that works on the
  // Preferences adapter, which can only remove keys it has *seen* this
  // session — an empty set on a fresh launch — so clearing the namespace
  // alone would be a no-op there.
  for (const key of ALL_IAP_STORAGE_KEYS) {
    try {
      await state.storage.remove(key);
    } catch (error) {
      state.logger.warn(`reset(): failed to remove the "${key}" key.`, error);
    }
  }

  // Finally the namespace itself. Best-effort and adapter-dependent: an
  // adapter that can enumerate by prefix (memory, and most custom ones)
  // sweeps anything not in the registry, while the Preferences adapter is
  // again limited to this session's keys. Ordering matters — a per-key
  // removal that threw leaves the key in the Preferences adapter's known
  // set, so this gives it a second attempt.
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
  //
  // `state.entitlements` rather than a literal `[]`, so the payload cannot
  // contradict the instance: a writer that repopulated during the awaits
  // above would otherwise have the event announce "nothing" while
  // `getEntitlements()` returned something.
  if (previous.length > 0) {
    state.emitter.emit('entitlements-changed', {
      entitlements: [...state.entitlements],
      previous,
    });
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
