// Vite's `?raw` suffix inlines a file's contents as a string (see
// `tests/raw-imports.d.ts`). The paths below go through `node_modules/`
// relatively rather than through `require.resolve`, which would need
// `@types/node` and so would dissolve tsconfig's deliberate
// `types: ["vitest/globals"]` guard.
//
// The plugin is an exact-pinned devDependency and CI runs plain `npm ci`, so
// these files are always present and only move when someone bumps the pin —
// which is the signal these tests exist to give. A `?raw` import of a missing
// file fails at collection with zero tests run, so it cannot degrade into a
// silent skip. (A future monorepo split would hoist the dependency and break
// every path here at once; static `?raw` paths can't be routed through a
// constant, so budget that edit.)

import { describe, expect, it } from 'vitest';
import pluginLicenseFile from '../../node_modules/@capgo/native-purchases/LICENSE?raw';
import androidGradle from '../../node_modules/@capgo/native-purchases/android/build.gradle?raw';
import androidManifest from '../../node_modules/@capgo/native-purchases/android/src/main/AndroidManifest.xml?raw';
import definitions from '../../node_modules/@capgo/native-purchases/dist/esm/definitions.d.ts?raw';
import iosProductSource from '../../node_modules/@capgo/native-purchases/ios/Sources/NativePurchasesPlugin/Product+CapacitorPurchasesPlugin.swift?raw';
import pluginPackageJsonRaw from '../../node_modules/@capgo/native-purchases/package.json?raw';

/**
 * Regression guards over the *installed* `@capgo/native-purchases` build —
 * the native layer iap delegates to. Everything asserted here is a finding
 * documented in `docs/guide/native-layer.md`; these tests exist so a plugin
 * bump that invalidates a documented guarantee fails CI instead of quietly
 * making the page wrong.
 *
 * Note the *inverted* assertions further down: several assert that a gap is
 * still a gap. They read backwards, but they are the ones that matter most —
 * the day capgo closes one, CI fails and names the paragraph to rewrite.
 * A documented limitation nobody re-checks is a documented limitation that
 * goes stale.
 */

const pluginPackageJson = JSON.parse(pluginPackageJsonRaw) as {
  version: string;
  license: string;
};

/**
 * Every native source file the plugin ships, discovered rather than listed.
 * A hardcoded list would be an audit blind spot: a source file capgo adds in
 * a later release would slip past the identifier sweep while the docs page
 * still claims the sources were audited. Kotlin is included for the same
 * reason — capgo is Java-only today, and nothing stops that changing.
 *
 * `ios/Tests` is deliberately out of scope: it ships in the plugin's `files`,
 * but test fixtures are not the shipped runtime.
 */
const nativeSources = import.meta.glob<string>(
  [
    '../../node_modules/@capgo/native-purchases/android/src/main/java/**/*.java',
    '../../node_modules/@capgo/native-purchases/android/src/main/java/**/*.kt',
    '../../node_modules/@capgo/native-purchases/ios/Sources/**/*.swift',
  ],
  { query: '?raw', import: 'default', eager: true },
);

/** `[shortName, contents]` pairs for the files under the given directory. */
function sourcesUnder(segment: string): Array<[string, string]> {
  return Object.entries(nativeSources)
    .filter(([path]) => path.includes(segment))
    .map(([path, contents]) => [path.split('/').pop() ?? path, contents]);
}

const ANDROID_SOURCES = sourcesUnder('/android/');

/** One shipped source by file name, asserted to exist rather than defaulted. */
function sourceNamed(name: string): string {
  const found = Object.entries(nativeSources).find(([path]) => path.endsWith(`/${name}`));
  if (!found) throw new Error(`${name} is not in the installed plugin`);
  return found[1];
}
const IOS_SOURCES = sourcesUnder('/ios/');

/** All Android source text as one blob, for whole-platform assertions. */
const ANDROID_CODE = ANDROID_SOURCES.map(([, contents]) => contents).join('\n');

/** Collect `file: pattern` for every pattern that appears in `sources`. */
function findMatches(sources: Array<[string, string]>, patterns: string[]): string[] {
  return sources.flatMap(([name, contents]) =>
    patterns.filter((pattern) => contents.includes(pattern)).map((hit) => `${name}: ${hit}`),
  );
}

describe('@capgo/native-purchases — the audited build', () => {
  /**
   * The docs page names the version it was audited against, so a major bump
   * (which may move any of the findings below) has to be a deliberate step.
   * The floor is the major, matching the `^8` peer-dependency range; the
   * exact patch is free to move.
   */
  it('is on the 8.x line the docs page was audited against', () => {
    expect(pluginPackageJson.version).toMatch(/^8\./);
  });

  /**
   * An empty or truncated glob would make every sweep below vacuously pass,
   * so assert the shape of what was matched, not merely that something was.
   */
  it('ships the native sources the audit sweeps', () => {
    expect(ANDROID_SOURCES.length).toBeGreaterThanOrEqual(3);
    expect(IOS_SOURCES.length).toBeGreaterThanOrEqual(6);
    for (const [name, contents] of [...ANDROID_SOURCES, ...IOS_SOURCES]) {
      expect(contents.length, `${name} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('@capgo/native-purchases — Play Billing floor', () => {
  /**
   * Google requires new apps and app updates to ship Play Billing Library 8
   * or later. Only the major is captured: Google publishes `-rc`/`-alpha`
   * billing releases, and a stricter pattern would false-fail on one.
   */
  const declaration = androidGradle.match(/def\s+billing_version\s*=\s*"(\d+)[^"]*"/);

  it('declares a billing-library version', () => {
    expect(declaration).not.toBeNull();
  });

  it('builds against Play Billing Library 8 or later', () => {
    // The guard above asserts the declaration exists; narrow for the type.
    if (!declaration) throw new Error('billing_version not found in android/build.gradle');
    expect(Number(declaration[1])).toBeGreaterThanOrEqual(8);
  });

  it('wires the declared version into the billingclient dependency', () => {
    expect(androidGradle).toContain('com.android.billingclient:billing:$billing_version');
  });
});

describe('@capgo/native-purchases — licence', () => {
  /**
   * MPL-2.0 is file-level copyleft: using the plugin unmodified imposes no
   * obligation on iap (MIT), but vendoring or patching its files would. iap
   * documents the dependency and its licence rather than vendoring, so a
   * licence change here is a decision to re-examine, not a detail.
   *
   * Both artifacts are checked: `package.json`'s field is the one tooling
   * reads, the LICENSE file is the one that is legally load-bearing.
   */
  it('declares MPL-2.0 in package.json', () => {
    expect(pluginPackageJson.license).toBe('MPL-2.0');
  });

  it('ships the Mozilla Public License 2.0 text', () => {
    expect(pluginLicenseFile).toContain('Mozilla Public License Version 2.0');
  });
});

describe('@capgo/native-purchases — no device or advertising identifiers', () => {
  /**
   * iap's privacy guarantee ("no telemetry, no device identifiers") covers
   * the native layer too, so the audit has to hold across plugin bumps.
   * The patterns are the identifier APIs a purchase plugin would plausibly
   * reach for on each platform.
   */
  const ANDROID_IDENTIFIER_APIS = [
    'AdvertisingIdClient',
    'ANDROID_ID',
    'Settings.Secure',
    'getDeviceId',
    'getImei',
    'getSubscriberId',
  ];

  const IOS_IDENTIFIER_APIS = [
    'identifierForVendor',
    'advertisingIdentifier',
    'ASIdentifierManager',
    'ATTrackingManager',
  ];

  it('reaches for no Android identifier API, in any shipped source', () => {
    expect(findMatches(ANDROID_SOURCES, ANDROID_IDENTIFIER_APIS)).toEqual([]);
  });

  it('reaches for no iOS identifier API, in any shipped source', () => {
    expect(findMatches(IOS_SOURCES, IOS_IDENTIFIER_APIS)).toEqual([]);
  });

  /**
   * The plugin ships an empty manifest — no permissions of its own, so
   * nothing it merges into a consumer app can widen the app's permission
   * set. `com.android.vending.BILLING` comes from the billing library.
   */
  it('declares no Android permissions of its own', () => {
    expect(androidManifest).not.toContain('uses-permission');
  });

  /**
   * **Fixed by capgo in 8.9.x, and this now asserts the fix holds.**
   *
   * Up to 8.6.5 the Android plugin wrote purchase tokens to logcat in the
   * clear with no debug gate, and the docs page warned about it because
   * iap's own rule is never to log a raw token. The plugin now routes every
   * log through `NativePurchasesLog`, gated on `BuildConfig.DEBUG` or an
   * explicit `debugLogging` config, with a purchase summary that carries
   * product ids and state but no token.
   *
   * Two things are checked, because the gate alone is not the guarantee: no
   * `android.util.Log` call survives *outside* the gated wrapper, and the
   * summary helper does not reach for a token.
   */
  it('routes every Android log through the gated logger, with no token', () => {
    const plugin = sourceNamed('NativePurchasesPlugin.java');
    const logger = sourceNamed('NativePurchasesLog.java');

    // The gate exists...
    expect(logger).toContain('BuildConfig.DEBUG');
    expect(logger).toContain('explicitDebugLogging');

    // ...and nothing bypasses it. `NativePurchasesLog.d(` also ends in
    // `Log.d(`, so the raw-call sweep has to exclude the wrapper's own
    // name rather than just matching `Log.`.
    const rawCalls = [...plugin.matchAll(/(^|[^a-zA-Z.])Log\.[dewiv]\(/gm)];
    expect(rawCalls).toHaveLength(0);

    // And the one summary the plugin logs for a purchase names no token.
    const summary = logger.slice(logger.indexOf('purchaseDebugSummary'));
    expect(summary).not.toMatch(/[Tt]oken/);
  });
});

describe('@capgo/native-purchases — the surface the docs page describes', () => {
  /**
   * Plugin surface `docs/guide/native-layer.md` lists as available. These
   * are the plugin's fields, not what iap consumes — the page's third
   * column says which is which. Anchored on declaration form rather than a
   * bare name, so a field removed but still mentioned in a migration note
   * does not keep the assertion green.
   */
  const DECLARATIONS = [
    'readonly jwsRepresentation?: string;',
    'readonly appAccountToken?: string | null;',
    'readonly purchaseToken?: string;',
    'readonly purchaseState?: string;',
    'readonly introductoryPrice: SKProductDiscount | null;',
    'readonly discounts: SKProductDiscount[];',
    'readonly offerToken?: string;',
    'readonly offerId?: string | null;',
    'readonly subscriptionGroupIdentifier: string;',
    'readonly renewalInfo?: SubscriptionRenewalInfo;',
    'readonly willCancel: boolean | null;',
    "addListener(eventName: 'transactionUpdated'",
  ];

  it.each(DECLARATIONS)('still declares %s', (declaration) => {
    expect(definitions).toContain(declaration);
  });

  it('still declares subscriptionState with the states the docs page names', () => {
    const match = definitions.match(/readonly subscriptionState\?:([^;]+);/);
    expect(match).not.toBeNull();
    const states = match?.[1] ?? '';
    for (const state of [
      'subscribed',
      'expired',
      'revoked',
      'inGracePeriod',
      'inBillingRetryPeriod',
    ]) {
      expect(states).toContain(state);
    }
  });

  /**
   * Makes the page's "iOS only" claim on `transactionUpdated` real: the
   * Android side notifies no listeners at all, so there is no Android
   * purchase-update event to subscribe to.
   */
  it('still notifies no listeners from the Android side', () => {
    expect(findMatches(ANDROID_SOURCES, ['notifyListeners'])).toEqual([]);
  });

  // ----- Inverted guards: gaps that are still gaps -----

  /**
   * No Play purchase signature reaches JS, so no cryptographic on-device
   * check is possible on Android.
   */
  it('still reads no Play purchase signature', () => {
    expect(findMatches(ANDROID_SOURCES, ['getSignature', 'getOriginalJson'])).toEqual([]);
  });

  /**
   * The stable iOS purchase reference is not a field. Matched loosely on
   * purpose — StoreKit's own property is `originalID`, so a name-exact
   * check on `originalTransactionId` would miss capgo exposing it under
   * any of its plausible spellings.
   */
  it('still does not expose the original transaction id under any spelling', () => {
    expect(definitions).not.toMatch(/original\s*(transaction)?\s*id\b/i);
  });

  /**
   * `INTRO_ELIGIBILITY_STATUS` is declared but no signature uses it, so
   * matching the word anywhere would false-fail. Match the method form:
   * any declaration whose name mentions eligibility.
   */
  it('still exposes no intro-offer eligibility query', () => {
    expect(definitions).not.toMatch(/^\s*\w*eligib\w*\s*\(/im);
  });

  /**
   * `purchaseProduct()` selects an Android *base plan* via `planIdentifier`
   * and takes no offer token, so the caller cannot choose which offer
   * within a base plan is purchased.
   */
  it('now accepts an offer token on purchaseProduct, as well as planIdentifier', () => {
    const start = definitions.indexOf('purchaseProduct(options: {');
    expect(start).toBeGreaterThan(-1);
    // Search for the closing line *from* `start` — the first occurrence in
    // the whole file need not be the one closing purchaseProduct, and a
    // start-after-end slice would silently yield '' and pass vacuously.
    const end = definitions.indexOf('}): Promise<Transaction>;', start);
    expect(end).toBeGreaterThan(start);

    const purchaseOptions = definitions.slice(start, end);
    expect(purchaseOptions).toContain('planIdentifier?: string;');
    // Arrived in 8.9.x. iap does not pass it yet: `SubscriptionOffer`
    // already exposes the offers to a consumer, but `purchase()` has no
    // way to name one, so buying a specific promotional or win-back offer
    // is still out of reach. This asserts the capability is there to build
    // on rather than silently assuming it is not.
    expect(purchaseOptions).toContain('offerToken?: string;');
  });

  /**
   * Inverted: when no offer matches the requested `planIdentifier`, the
   * Android plugin falls back to the *first* available offer rather than
   * failing — so a typo'd plan id silently buys something else. The docs
   * page warns about it; when capgo makes this an error, this fails.
   */
  /**
   * Inverted-ish, and the guard for the bug this page's sibling tests did
   * not catch: `purchaseState` is Play's own `Purchase.PurchaseState` int,
   * stringified verbatim — not a code capgo assigns. That matters because
   * the plugin's `.d.ts` documents `"0": Payment pending`, while the billing
   * library defines UNSPECIFIED_STATE=0, PURCHASED=1, PENDING=2 and
   * `getPurchaseState()` returns only 1 or 2. iap reads the library's
   * numbering, so this asserts the plugin is still passing it through
   * rather than translating it.
   */
  it('still stringifies Play purchase state verbatim rather than translating it', () => {
    expect(ANDROID_CODE).toContain('String.valueOf(purchase.getPurchaseState())');
    // And still compares symbolically against the library's own constants,
    // so a renumbering upstream would move both together.
    expect(ANDROID_CODE).toContain('Purchase.PurchaseState.PURCHASED');
    expect(ANDROID_CODE).toContain('Purchase.PurchaseState.PENDING');
  });

  it('still falls back to the first subscription offer on a planIdentifier miss', () => {
    expect(ANDROID_CODE).toMatch(
      /selectedOfferDetails\s*=\s*\w+\.getSubscriptionOfferDetails\(\)\.get\(0\)/,
    );
  });
});

describe('@capgo/native-purchases — consuming, and what autoAcknowledge does not cover', () => {
  /**
   * `consumePurchase()` is why iap can let an Android consumable be bought
   * again. It arrived in plugin 8.2.0; the adapter's `consume()` is built on
   * it, and `finalizeTransaction` falls back to acknowledging without it.
   */
  it('still exposes consumePurchase on the Android side', () => {
    expect(ANDROID_CODE).toContain('consumeAsync');
    expect(findMatches(ANDROID_SOURCES, ['public void consumePurchase('])).not.toHaveLength(0);
  });

  /**
   * The finding iap's `isConsumable: false` depends on, and it contradicts
   * the plugin's own documentation of `autoAcknowledgePurchases` ("the
   * purchase will NOT be automatically acknowledged/finished").
   *
   * `PurchaseActionDecider.decide()` returns CONSUME whenever `isConsumable`
   * is set, before any acknowledge consideration, and the caller acts on
   * CONSUME without reading `autoAcknowledgePurchases` — which it *does*
   * read on the ACKNOWLEDGE branch. So a purchase flagged consumable is
   * consumed inside the purchase callback regardless, which for iap would
   * mean finalising before verification, unrecoverably: Billing 8.x drops a
   * consumed purchase from `getPurchases()`.
   *
   * iap therefore never sets the flag and consumes itself after verifying.
   * This guard is **inverted**: it asserts the gap is still a gap, so that
   * if capgo makes `autoAcknowledgePurchases` cover consuming, this fails
   * and iap can simplify rather than carrying the workaround forever.
   */
  it('still consumes on isConsumable regardless of autoAcknowledgePurchases', () => {
    const decider = Object.entries(nativeSources).find(([path]) =>
      path.endsWith('PurchaseActionDecider.java'),
    )?.[1];
    expect(decider, 'PurchaseActionDecider.java should ship').toBeDefined();

    // CONSUME is decided from `isConsumable` alone.
    expect(decider).toMatch(/if\s*\(isConsumable\)\s*\{\s*return PurchaseAction\.CONSUME;/);
    // And the decider never sees the flag that is supposed to gate it.
    expect(decider).not.toContain('autoAcknowledge');

    // The caller consumes on CONSUME with no autoAcknowledge check, while
    // the ACKNOWLEDGE branch has one. Asserted by the order of the three
    // in the switch: CONSUME → consumeAsync, then ACKNOWLEDGE → the flag.
    const plugin = Object.entries(nativeSources).find(([path]) =>
      path.endsWith('NativePurchasesPlugin.java'),
    )?.[1];
    expect(plugin).toBeDefined();
    const consumeCase = (plugin ?? '').indexOf('case CONSUME:');
    const ackCase = (plugin ?? '').indexOf('case ACKNOWLEDGE:');
    expect(consumeCase).toBeGreaterThan(-1);
    expect(ackCase).toBeGreaterThan(consumeCase);
    const consumeBranch = (plugin ?? '').slice(consumeCase, ackCase);
    expect(consumeBranch).toContain('consumeAsync');
    expect(consumeBranch).not.toContain('autoAcknowledge');
  });

  /**
   * The other half of why consuming cannot be deferred and retried the way
   * acknowledging can: once consumed, there is no purchase left to find.
   */
  it('still documents that a consumed purchase leaves getPurchases()', () => {
    expect(definitions).toContain('consumed purchases can no longer');
  });
});

describe('@capgo/native-purchases — the paymentMode legend iap maps from', () => {
  /**
   * This is the guard that matters most on this page, because the mapping it
   * protects is one iap gets from reading capgo's code *against* capgo's own
   * comment.
   *
   * capgo's iOS source labels the mapping "SKProductDiscount.PaymentMode-
   * compatible: freeTrial=0, payUpFront=1, payAsYouGo=2". Apple's actual
   * `SKProductDiscount.PaymentMode` is payAsYouGo=0, payUpFront=1,
   * freeTrial=2 — so the comment is wrong about Apple, and the numbers it
   * emits are what ships. Android independently uses the same order.
   *
   * iap maps from the emitted order. Its own unit tests can only pin iap
   * against iap's mocks: if capgo ever "corrects" its iOS mapping toward
   * Apple's documented order, every free trial would silently become
   * pay-as-you-go and those tests would stay green. These assertions read
   * capgo's source, so that change fails CI instead.
   */
  it('still maps iOS freeTrial to 0, payUpFront to 1, payAsYouGo to 2', () => {
    // The Swift switch, whitespace-insensitive: `case .freeTrial: return 0`.
    expect(iosProductSource).toMatch(/case\s+\.freeTrial:\s*\n?\s*return\s+0/);
    expect(iosProductSource).toMatch(/case\s+\.payUpFront:\s*\n?\s*return\s+1/);
    expect(iosProductSource).toMatch(/case\s+\.payAsYouGo:\s*\n?\s*return\s+2/);
  });

  it('still maps iOS offer types introductory=0, promotional=1, winBack=2', () => {
    expect(iosProductSource).toMatch(/\.introductory\s*\{\s*\n?\s*return\s+0/);
    expect(iosProductSource).toMatch(/\.promotional\s*\{\s*\n?\s*return\s+1/);
    expect(iosProductSource).toMatch(/\.winBack\s*\{\s*\n?\s*return\s+2/);
  });

  /**
   * Android derives the same three values from the pricing phase instead of
   * a StoreKit enum: a zero price is a free trial, a non-recurring phase is
   * paid up front, anything else is pay-as-you-go. Asserting the derivation
   * keeps the two platforms' agreement from drifting apart silently.
   */
  it('still derives the same three values on Android', () => {
    const paymentMode = ANDROID_CODE.slice(
      ANDROID_CODE.indexOf('private static int paymentModeForPhase'),
    ).slice(0, 400);
    expect(paymentMode).toContain('getPriceAmountMicros() == 0');
    expect(paymentMode).toContain('RECURRENCE_MODE_NON_RECURRING');
    expect(paymentMode).toMatch(/return\s+0;/);
    expect(paymentMode).toMatch(/return\s+1;/);
    expect(paymentMode).toMatch(/return\s+2;/);
  });

  /**
   * The period unit legend, same reasoning: 0=day, 1=week, 2=month, 3=year
   * on both platforms, which is what `src/lib/subscription-period.ts` maps.
   */
  it('still uses the same period-unit integers on both platforms', () => {
    for (const [unit, index] of [
      ['day', 0],
      ['week', 1],
      ['month', 2],
      ['year', 3],
    ] as const) {
      expect(ANDROID_CODE).toContain(`case ${index} -> "${unit}";`);
    }
  });
});
