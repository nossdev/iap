# Testing on sandbox

Apple and Google both provide sandbox environments where you can complete real purchase flows without being charged. This page covers setup for both platforms plus a few unit-test patterns for `@nossdev/iap` itself.

## iOS — App Store sandbox

### 1. Create sandbox testers

In **App Store Connect** → **Users and Access** → **Sandbox Testers** → **+**, create a sandbox account:

- Email: any email (doesn't need to be real or active)
- Password: must satisfy Apple's complexity rules
- Region: pick the region whose pricing/currency you want to test
- Date of birth: any adult date

::: warning Use a dedicated email
Once an email is registered as a sandbox tester, it cannot be used for the live App Store. Don't use your personal Apple ID — make a sandbox-specific one.
:::

### 2. Sign into sandbox on the device

iOS 15+ uses StoreKit 2's **transaction-level sandbox** rather than account-level. To sign in:

- **Settings** → **App Store** → scroll to bottom → **Sandbox Account** → **Sign In**
- Enter your sandbox tester credentials.

You'll stay signed into your real Apple ID for everything else; only purchases inside apps will use the sandbox account.

### 3. Configure products in App Store Connect

For each product in your `createIAP({ products })` config:

- **My Apps** → your app → **Monetization** → **In-App Purchases** (or **Subscriptions**)
- Create the product with the SAME `id` as in your config.
- For subscriptions, create a **Subscription Group**, then a subscription within it. Set pricing per region.
- Set the product to **Ready to Submit** (it doesn't have to be approved to test in sandbox — just configured).

### 4. Test the flow

```typescript
const result = await iap.purchase({ productId: 'premium_monthly' });
console.log(result);
```

In sandbox:

- The system purchase sheet shows `[Sandbox]` prefixes.
- Subscription periods are accelerated: 1 month → 5 minutes, 1 year → 1 hour. Useful for testing renewal logic, less useful if you forget and let one renew 5 times overnight.
- You can manage and cancel sandbox subscriptions via **Settings** → **App Store** → **Sandbox Account** → **Manage**.

## Android — Google Play license testers

### 1. Add license testers

In **Google Play Console** → **Setup** → **License testing**, add the Google accounts you want to test with. License testers can buy products without being charged — Google issues a "test transaction" receipt instead.

### 2. Configure products in Play Console

- **Monetize** → **Products** → **In-app products** (or **Subscriptions** for subs).
- Create products with the SAME `id` as your `createIAP({ products })` config.
- For subscriptions, create at least one **base plan** with the SAME `androidPlanId` as your config.
- **Activate** the product (subs need at least one offer/base plan active to be returned by the Billing API).

### 3. Upload a build to a test track

License testers can only buy from app builds installed via:

- An **internal test track** signed with the same key Google Play will use, OR
- An **internal app sharing** link.

`adb install` on a debug-signed APK will NOT see the Billing products. You MUST go through Play tracks. This catches most teams off guard the first time.

Workflow:

1. Build a release-signed APK / AAB.
2. Upload to **Internal testing** track.
3. Add testers (email list or Google Group).
4. Tester opens the test-track opt-in URL Google generates, installs from Play.

### 4. Test the flow

The flow is identical to iOS from the consumer's perspective. Sub-period acceleration on Android:

- 1 day → 5 minutes
- 1 week → 5 minutes
- 1 month → 30 minutes
- 1 year → 2 hours

## Server-side: Attesto sandbox

Your backend's `verifyApple` / `verifyGoogle` paths call Attesto. Attesto distinguishes sandbox vs. production receipts automatically — there's no flag to set in the request. Apple/Google sign sandbox receipts differently; Attesto inspects the signing context.

If your backend has separate environments (staging vs. prod), point the staging environment at sandbox-only API keys to avoid accidentally writing test entitlements to production users.

::: tip Attesto webhooks in sandbox
Attesto delivers Apple App Store Server Notifications v2 and Google RTDN webhooks to your backend the same way in sandbox and production. If you're testing renewal handling, configure both environments to receive webhooks at distinct paths (e.g. `/webhooks/attesto-prod` vs `/webhooks/attesto-staging`).
:::

## Unit testing your code that uses `@nossdev/iap`

The `IAP` instance is a plain object with methods and an event emitter — easy to mock without touching the native plugin.

### Strategy 1: Mock the whole instance

For UI tests where you don't care about IAP internals:

```typescript
// __mocks__/iap.ts
export const iap = {
  initialize: vi.fn().mockResolvedValue(undefined),
  hasEntitlement: vi.fn().mockReturnValue(false),
  getEntitlements: vi.fn().mockReturnValue([]),
  getEntitlement: vi.fn().mockReturnValue(null),
  purchase: vi.fn().mockResolvedValue({ status: 'success', /* ... */ }),
  restorePurchases: vi.fn().mockResolvedValue({ restored: 0, entitlements: [] }),
  refresh: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  on: vi.fn().mockReturnValue(() => {}),
  getProducts: vi.fn().mockReturnValue([]),
};
```

### Strategy 2: Real instance, in-memory storage

For integration-ish tests that exercise more of the library:

```typescript
import { createIAP } from '@nossdev/iap';

const iap = createIAP({
  products: [{ id: 'premium', type: 'subscription', androidPlanId: 'monthly' }],
  backend: {
    adapter: createFakeBackendAdapter(),    // your test double
    timeoutMs: 1000,
    retries: 0,
  },
  storage: { type: 'memory', namespace: 'test' },  // in-memory, no Capacitor needed
  options: {
    refreshOnResume: false,
    recoverUnfinishedTransactions: false,
    logLevel: 'silent',
  },
});

await iap.initialize();
```

This lets you test your reactive store wiring, paywall logic, etc., without mocking individual methods. The web-stub native adapter takes over automatically (since you're running in jsdom / Node).

### Strategy 3: E2E tests on a device

Sandbox + Playwright/Detox works for full E2E, but it's expensive and slow. We recommend reserving E2E for the critical path (one happy-path purchase per platform per release) and using strategies 1–2 for everything else.

## Common gotchas

- **`PRODUCT_NOT_FOUND` in sandbox** — usually means the product isn't fully configured (price tier missing, contracts pending, missing tax info). Check **App Store Connect → Agreements, Tax, and Banking** has all green checks for the IAP agreement.
- **"This Apple ID has not yet been used in the iTunes Store"** — switch to a different sandbox account or sign your existing one in via **Settings → App Store**.
- **Android: `BILLING_RESPONSE_RESULT_DEVELOPER_ERROR`** — usually means your app's package name + signing key don't match what's on the test track. Re-upload the same artifact to the test track.
- **`BACKEND_AUTH_FAILED` only in sandbox** — your backend probably requires staging-only auth headers your sandbox build isn't sending. Check `getAuthHeaders()` returns env-aware values.

## Next

- [Backend contract](/guide/backend-contract) — what your backend should return for sandbox receipts
- [Error handling](/guide/error-handling) — every code you might hit during testing
