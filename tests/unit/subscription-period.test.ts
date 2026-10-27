import { describe, expect, it } from 'vitest';
import { toIso8601Duration } from '../../src/lib/subscription-period.js';

/**
 * `@capgo/native-purchases` reports a subscription period as
 * `{ numberOfUnits, unit, unitString? }`. Both platforms agree on the integer
 * legend (0=day, 1=week, 2=month, 3=year) and both emit `unitString` since
 * 8.3.8 — but the shape is reconstructed from different sources per platform
 * (StoreKit's `Product.SubscriptionPeriod` on iOS, a parsed ISO 8601 billing
 * period on Android), so the normalizer has to tolerate both and neither.
 */
describe('toIso8601Duration', () => {
  it('maps each unit from unitString', () => {
    expect(toIso8601Duration({ numberOfUnits: 7, unitString: 'day' })).toBe('P7D');
    expect(toIso8601Duration({ numberOfUnits: 2, unitString: 'week' })).toBe('P2W');
    expect(toIso8601Duration({ numberOfUnits: 1, unitString: 'month' })).toBe('P1M');
    expect(toIso8601Duration({ numberOfUnits: 1, unitString: 'year' })).toBe('P1Y');
  });

  it('falls back to the integer legend when unitString is absent', () => {
    // Plugins before 8.3.8 omit unitString entirely.
    expect(toIso8601Duration({ numberOfUnits: 3, unit: 0 })).toBe('P3D');
    expect(toIso8601Duration({ numberOfUnits: 3, unit: 1 })).toBe('P3W');
    expect(toIso8601Duration({ numberOfUnits: 3, unit: 2 })).toBe('P3M');
    expect(toIso8601Duration({ numberOfUnits: 3, unit: 3 })).toBe('P3Y');
  });

  it('falls back to the integer legend when unitString is "unknown"', () => {
    // Both platforms emit "unknown" for a unit they do not recognise, but
    // may still have put a usable integer in `unit`.
    expect(toIso8601Duration({ numberOfUnits: 6, unit: 2, unitString: 'unknown' })).toBe('P6M');
  });

  it('prefers unitString over a disagreeing integer', () => {
    // unitString is the newer, explicit field; the integer is the legacy one.
    expect(toIso8601Duration({ numberOfUnits: 1, unit: 0, unitString: 'year' })).toBe('P1Y');
  });

  it('returns null for the placeholder both platforms emit for non-subscriptions', () => {
    // iOS writes { numberOfUnits: 0, unit: 0 } for a product with no
    // subscription; a zero-length period is not a period.
    expect(toIso8601Duration({ numberOfUnits: 0, unit: 0 })).toBeNull();
  });

  it('returns null when the period is missing entirely', () => {
    // Android never sets a top-level subscriptionPeriod on a product, even
    // though the plugin's types declare it as required.
    expect(toIso8601Duration(undefined)).toBeNull();
    expect(toIso8601Duration(null)).toBeNull();
  });

  it('returns null for an unrecognised unit', () => {
    // -1 is what both platforms emit for a StoreKit/Play unit they do not
    // know — a future period type neither iap nor capgo can name.
    expect(toIso8601Duration({ numberOfUnits: 1, unit: -1 })).toBeNull();
    expect(toIso8601Duration({ numberOfUnits: 1, unit: 9 })).toBeNull();
    expect(toIso8601Duration({ numberOfUnits: 1, unitString: 'fortnight' })).toBeNull();
  });

  it('returns null for a unit with no count to go with it', () => {
    expect(toIso8601Duration({ unitString: 'month' })).toBeNull();
  });

  it('returns null for counts that are not positive whole numbers', () => {
    expect(toIso8601Duration({ numberOfUnits: -1, unitString: 'month' })).toBeNull();
    expect(toIso8601Duration({ numberOfUnits: 1.5, unitString: 'month' })).toBeNull();
    expect(toIso8601Duration({ numberOfUnits: Number.NaN, unitString: 'month' })).toBeNull();
    expect(toIso8601Duration({ numberOfUnits: '1', unitString: 'month' })).toBeNull();
  });

  it('returns null for a unit name that is an Object prototype member', () => {
    // A plain-object lookup table resolves inherited keys, so a `unitString`
    // of "constructor" used to yield the Object constructor and render
    // "P1function Object() { [native code] }" — typed as string.
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(toIso8601Duration({ numberOfUnits: 1, unitString: name })).toBeNull();
    }
  });

  it('never throws on a shape it was not promised', () => {
    // The input crosses a native bridge, so it is untrusted by construction.
    for (const input of ['P1M', 42, [], true, {}, { numberOfUnits: {} }]) {
      expect(() => toIso8601Duration(input)).not.toThrow();
      expect(toIso8601Duration(input)).toBeNull();
    }
  });
});
