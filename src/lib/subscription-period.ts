/**
 * Normalizes `@capgo/native-purchases`' subscription-period shape into an
 * ISO 8601 duration string (`P1M`, `P7D`, …).
 *
 * The plugin reports `{ numberOfUnits, unit, unitString? }`, reconstructed
 * from a different source on each platform — StoreKit's
 * `Product.SubscriptionPeriod` on iOS, a parsed Play billing period on
 * Android — so the input is normalized here rather than in core flows.
 *
 * ISO 8601 is the exchange format because it is what Google Play speaks
 * natively, what Apple's App Store Server API emits, and what a consumer can
 * hand to any date library without a per-platform legend.
 */

/**
 * Unit integers. Both platforms emit 0-3 with the same meaning; iOS also
 * emits -1 for a StoreKit unit it does not recognise (Android never does).
 *
 * A `Map`, not an object literal: the key comes off a native bridge, and a
 * plain object would resolve inherited names — a `unitString` of
 * "constructor" would otherwise yield the Object constructor and render as
 * "P1function Object() { [native code] }".
 */
const UNIT_BY_INT: ReadonlyMap<number, string> = new Map([
  [0, 'D'],
  [1, 'W'],
  [2, 'M'],
  [3, 'Y'],
]);

/** `unitString`, added by the plugin in 8.3.8. Preferred when present. */
const UNIT_BY_NAME: ReadonlyMap<string, string> = new Map([
  ['day', 'D'],
  ['week', 'W'],
  ['month', 'M'],
  ['year', 'Y'],
]);

/**
 * The plugin's period shape, typed loosely on purpose: the value crosses a
 * native bridge, and the plugin's own declarations overstate what is always
 * present (Android sets no top-level `subscriptionPeriod` on a product at
 * all, though the type says it is required).
 */
interface NativeSubscriptionPeriod {
  numberOfUnits?: unknown;
  unit?: unknown;
  unitString?: unknown;
}

/**
 * Convert a native subscription period to an ISO 8601 duration, or `null`
 * when the input does not describe one.
 *
 * `null` covers every "no usable period" case, which a caller should treat
 * identically: absent (Android products), the `{ numberOfUnits: 0, unit: 0 }`
 * placeholder both platforms emit for non-subscriptions, an unrecognised
 * unit, or a malformed value.
 */
export function toIso8601Duration(period: unknown): string | null {
  if (!period || typeof period !== 'object' || Array.isArray(period)) return null;

  const { numberOfUnits, unit, unitString } = period as NativeSubscriptionPeriod;

  if (typeof numberOfUnits !== 'number' || !Number.isInteger(numberOfUnits) || numberOfUnits <= 0) {
    return null;
  }

  // `unitString` is the explicit field and wins; the integer is the legacy
  // fallback for plugin builds predating 8.3.8, and for the "unknown"
  // string, which may still arrive alongside a usable integer.
  const designator =
    (typeof unitString === 'string' ? UNIT_BY_NAME.get(unitString) : undefined) ??
    (typeof unit === 'number' ? UNIT_BY_INT.get(unit) : undefined);

  if (!designator) return null;

  return `P${numberOfUnits}${designator}`;
}
