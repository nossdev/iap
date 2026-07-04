import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockedPlatform: 'ios' | 'android' | 'web' = 'ios';
// Whether the native plugin header advertises getStorefront. The adapter
// detects availability via Capacitor.PluginHeaders (not `typeof`), because on a
// real device the plugin Proxy fabricates a function for any name.
let mockStorefrontRegistered = true;
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
    isNativePlatform: () => mockedPlatform !== 'web',
    get PluginHeaders() {
      return [
        {
          name: 'NativePurchases',
          methods: [
            { name: 'getProducts' },
            ...(mockStorefrontRegistered ? [{ name: 'getStorefront' }] : []),
          ],
        },
      ];
    },
  },
}));

// The native plugin advertises getStorefront via the mocked header above, so the
// normalization paths are exercised; the "absent" case flips mockStorefrontRegistered.
const nativePurchasesMock = vi.hoisted(() => ({
  isBillingSupported: vi.fn(),
  getProducts: vi.fn(),
  purchaseProduct: vi.fn(),
  getPurchases: vi.fn(),
  acknowledgePurchase: vi.fn(),
  manageSubscriptions: vi.fn(),
  getStorefront: vi.fn(),
}));

vi.mock('@capgo/native-purchases', () => ({
  NativePurchases: nativePurchasesMock,
  PURCHASE_TYPE: { INAPP: 'inapp', SUBS: 'subs' },
}));

import { CapgoNativeAdapter } from '../../src/adapters/native/capgo/native-adapter.js';
import { WebStubAdapter } from '../../src/adapters/native/web/web-stub.js';
import { toAlpha2 } from '../../src/lib/iso-country.js';

describe('toAlpha2 — ISO 3166-1 alpha-3 → alpha-2 normalization', () => {
  it.each([
    ['USA', 'US'],
    ['GBR', 'GB'],
    ['DEU', 'DE'],
    ['JPN', 'JP'],
    ['KOR', 'KR'],
    ['NLD', 'NL'],
  ])('maps alpha-3 %s → %s', (input, expected) => {
    expect(toAlpha2(input)).toBe(expected);
  });

  it('passes through an already-alpha-2 code (Android), uppercasing it', () => {
    expect(toAlpha2('US')).toBe('US');
    expect(toAlpha2('gb')).toBe('GB');
  });

  it('is case-insensitive and trims for alpha-3 input', () => {
    expect(toAlpha2('usa')).toBe('US');
    expect(toAlpha2(' DEU ')).toBe('DE');
  });

  it('returns null for unknown / malformed codes', () => {
    expect(toAlpha2('XXX')).toBeNull();
    expect(toAlpha2('')).toBeNull();
    expect(toAlpha2('U')).toBeNull();
    expect(toAlpha2('USAA')).toBeNull();
    expect(toAlpha2('UNITED')).toBeNull();
  });
});

describe('WebStubAdapter.getStorefront', () => {
  it('returns null on web', async () => {
    expect(await new WebStubAdapter().getStorefront()).toBeNull();
  });
});

describe('CapgoNativeAdapter.getStorefront', () => {
  beforeEach(() => {
    mockedPlatform = 'ios';
    mockStorefrontRegistered = true;
    nativePurchasesMock.getStorefront.mockReset();
  });

  it('normalizes an iOS alpha-3 storefront to alpha-2 and preserves raw + id', async () => {
    mockedPlatform = 'ios';
    nativePurchasesMock.getStorefront.mockResolvedValue({
      countryCode: 'USA',
      storefrontId: '143441',
    });

    const sf = await new CapgoNativeAdapter().getStorefront();

    expect(sf).toEqual({
      countryCode: 'US',
      countryCodeRaw: 'USA',
      storefrontId: '143441',
      platform: 'apple',
    });
  });

  it('passes through an Android alpha-2 storefront unchanged (no storefrontId)', async () => {
    mockedPlatform = 'android';
    nativePurchasesMock.getStorefront.mockResolvedValue({ countryCode: 'US' });

    const sf = await new CapgoNativeAdapter().getStorefront();

    expect(sf).toEqual({
      countryCode: 'US',
      countryCodeRaw: 'US',
      storefrontId: undefined,
      platform: 'google',
    });
  });

  it('returns null when the store reports an empty country (EU alt-distribution)', async () => {
    nativePurchasesMock.getStorefront.mockResolvedValue({ countryCode: '' });
    expect(await new CapgoNativeAdapter().getStorefront()).toBeNull();
  });

  it('returns null when the store reports a whitespace-only country', async () => {
    nativePurchasesMock.getStorefront.mockResolvedValue({ countryCode: '   ' });
    expect(await new CapgoNativeAdapter().getStorefront()).toBeNull();
  });

  it('trims padded native codes before normalizing', async () => {
    mockedPlatform = 'ios';
    nativePurchasesMock.getStorefront.mockResolvedValue({ countryCode: ' USA ' });
    const sf = await new CapgoNativeAdapter().getStorefront();
    expect(sf).toMatchObject({ countryCode: 'US', countryCodeRaw: 'USA' });
  });

  it('falls back to the raw uppercased code when the alpha-3 is unknown', async () => {
    mockedPlatform = 'ios';
    nativePurchasesMock.getStorefront.mockResolvedValue({ countryCode: 'xyz' });

    const sf = await new CapgoNativeAdapter().getStorefront();

    expect(sf).toMatchObject({ countryCode: 'XYZ', countryCodeRaw: 'xyz', platform: 'apple' });
  });

  it('returns null when the native value is missing entirely', async () => {
    nativePurchasesMock.getStorefront.mockResolvedValue(undefined);
    expect(await new CapgoNativeAdapter().getStorefront()).toBeNull();
  });

  it('returns null (silently) when the plugin call rejects', async () => {
    nativePurchasesMock.getStorefront.mockRejectedValue(new Error('no bridge'));
    expect(await new CapgoNativeAdapter().getStorefront()).toBeNull();
  });

  it('returns null WITHOUT crossing the bridge when the native plugin lacks getStorefront', async () => {
    // Older @capgo/native-purchases builds don't register the method, so the
    // Capacitor plugin header omits it. The adapter must short-circuit rather
    // than call the Proxy-fabricated function (which would throw natively).
    mockStorefrontRegistered = false;
    expect(await new CapgoNativeAdapter().getStorefront()).toBeNull();
    expect(nativePurchasesMock.getStorefront).not.toHaveBeenCalled();
  });
});
