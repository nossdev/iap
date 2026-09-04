# Error handling

Every error the library throws is an `IAPError` — a typed `Error` subclass with a stable `code`, a remediation hint, and (when applicable) a `cause` chain to the underlying failure.

## Anatomy of an `IAPError`

```typescript
import { IAPError, IAPErrorCode, isIAPError, errorHint } from '@nosslabs/iap';

try {
  await iap.purchase({ productId: 'premium_monthly' });
} catch (error) {
  if (isIAPError(error)) {
    error.code;         // IAPErrorCode — stable enum, safe to switch on
    error.message;      // human-readable description + auto-appended hint
    error.recoverable;  // boolean — should the UI offer "try again"?
    error.cause;        // unknown — original error from native/backend, if any
  }
}
```

The `message` looks like:

```
Backend returned 401 Unauthorized

Hint: Backend returned 401/403. Check that getAuthHeaders() returns a valid Bearer token and that the backend recognizes it.
```

Hints are auto-appended unless the constructor was called with `includeHint: false` (rare — only used internally when the message already contains remediation text, e.g. zod validation errors).

## Switching on `code`

The `error.code` field is a stable string enum. **Switch on it** rather than parsing `message`:

```typescript
import { IAPErrorCode, isIAPError } from '@nosslabs/iap';

try {
  await iap.purchase({ productId: 'premium_monthly' });
} catch (error) {
  if (!isIAPError(error)) throw error;

  switch (error.code) {
    case IAPErrorCode.USER_CANCELLED:
      // No-op — user dismissed the sheet
      break;
    case IAPErrorCode.PURCHASE_PENDING:
      toast('Payment processing — we\'ll notify you when it clears');
      break;
    case IAPErrorCode.BACKEND_AUTH_FAILED:
      // Re-auth the user
      router.push('/login');
      break;
    case IAPErrorCode.BACKEND_UNAVAILABLE:
    case IAPErrorCode.BACKEND_TIMEOUT:
      toast('Network issue — please try again');
      break;
    default:
      toast(`Purchase failed: ${error.message}`);
  }
}
```

::: tip Prefer `iap.purchase()` discriminated result
For the purchase flow specifically, the discriminated union from `iap.purchase()` is more ergonomic than try/catch — see [Getting started → Buy something](/v5/guide/getting-started#_4-buy-something). Use try/catch for `restorePurchases()`, `refresh()`, and `initialize()`.
:::

## All error codes

| Code | Recoverable | When it fires | What to do |
|---|---|---|---|
| `INVALID_CONFIG` | no | `createIAP({ ... })` — schema validation failed | Fix the config; re-read the field paths in the message |
| `NOT_INITIALIZED` | no | A method called before `initialize()` resolved | `await iap.initialize()` first |
| `PLATFORM_NOT_SUPPORTED` | no | `purchase()` / `restorePurchases()` on web | Guard the UI behind `Capacitor.isNativePlatform()` |
| `BILLING_NOT_AVAILABLE` | no | `cordova-plugin-purchase` couldn't initialize | Check `npx cap sync` ran; check device sandbox account |
| `PRODUCT_NOT_FOUND` | no | Purchasing a productId not in the store catalog | Verify productId in App Store Connect / Play Console AND in `createIAP({ products })` |
| `USER_CANCELLED` | no | User dismissed the system purchase sheet | No action needed |
| `PURCHASE_PENDING` | no | Android: payment awaiting external clearance | Tell the user; trust the backend webhook |
| `ALREADY_PURCHASED` | no | Buying a non-consumable the user already owns | Use `restorePurchases()` to re-grant |
| `STORE_ERROR` | no | Generic native-side failure (declined card, store down) | Surface message; offer retry |
| `UNACKNOWLEDGED_PENDING` | yes | Google purchase >2 days unacknowledged | Library auto-retries on next refresh |
| `ALREADY_IN_PROGRESS` | no | Concurrent `purchase()` for same productId | Await the in-flight call |
| `BACKEND_UNAVAILABLE` | yes | Backend unreachable / 5xx / network drop | Library auto-retries; surface to user if persistent |
| `BACKEND_TIMEOUT` | yes | Backend exceeded `timeoutMs` | Increase `timeoutMs` or check server perf |
| `BACKEND_AUTH_FAILED` | no | 401 / 403 from backend | Re-auth user; check `getAuthHeaders()` |
| `BACKEND_BAD_RESPONSE` | no | 4xx / malformed JSON / schema mismatch | Backend doesn't match [contract](/v5/guide/backend-contract) |
| `VERIFICATION_REJECTED` | no | Backend returned `{ valid: false }` | Don't auto-retry; transaction stays in queue for `iap.refresh()` |
| `STORAGE_ERROR` | yes | Capacitor Preferences write failed | In-memory state is fine; persistence will retry |
| `INVALID_APP_USER_ID` | no | `purchase({ appUserId })` value (literal or fetcher-returned) isn't a UUID v4 | Pass `crypto.randomUUID()` or omit `appUserId` to fall back to subject.key mapping |
| `APP_USER_ID_FETCH_FAILED` | no | The async appUserId fetcher threw or rejected | Inspect `error.cause` for the underlying error (network failure, backend non-2xx) |

Get the per-code hint programmatically:

```typescript
import { errorHint, IAPErrorCode } from '@nosslabs/iap';

console.log(errorHint(IAPErrorCode.BACKEND_AUTH_FAILED));
// → "Backend returned 401/403. Check that getAuthHeaders() returns a valid Bearer token..."
```

## `recoverable` flag

`error.recoverable: boolean` is a hint to your UI: should the "try again" button appear?

- **Recoverable** (`true`) — transient: backend was down, network blipped, storage write failed. The library has likely retried already and exhausted attempts; a user-initiated retry might succeed.
- **Non-recoverable** (`false`) — fatal: bad config, invalid receipt, user cancelled, platform unsupported. Retry will produce the same error.

Default classifications:

- Recoverable: `BACKEND_UNAVAILABLE`, `BACKEND_TIMEOUT`, `STORAGE_ERROR`, `UNACKNOWLEDGED_PENDING`
- Everything else: non-recoverable

You can override per-throw via the constructor's `recoverable` option, but stick with defaults unless you have a strong reason.

## The `cause` chain

When the library wraps an underlying error, `cause` preserves the original:

```typescript
try {
  await iap.refresh();
} catch (error) {
  if (isIAPError(error)) {
    console.error('IAP error:', error.code, error.message);

    if (error.cause instanceof Error) {
      // Original fetch error, JSON parse error, etc.
      Sentry.captureException(error.cause);
    }
  }
}
```

Always log `error.cause` separately from `error` itself if you're shipping to Sentry / Datadog — the cause has the underlying stack trace, while `IAPError` has the orchestration context.

## Logging hygiene

The library logs at the `logLevel` you configure (default `'info'`). Recommended levels:

- **Production**: `'warn'` — captures `STORE_ERROR`, `BACKEND_AUTH_FAILED`, etc., without the noisy debug trace.
- **Development**: `'debug'` — full trace of every native event, backend call, and entitlement diff.
- **Tests**: `'silent'` — keep test output clean.

Plug in a custom logger to ship to your observability stack:

```typescript
const config = {
  // ...
  options: {
    logLevel: 'warn',
    logger: {
      error: (msg, ctx) => Sentry.captureMessage(msg, { extra: ctx }),
      warn:  (msg, ctx) => Sentry.captureMessage(msg, { extra: ctx, level: 'warning' }),
      info:  () => {}, // drop info in prod
      debug: () => {}, // drop debug in prod
    },
  },
};
```

::: warning Don't log receipt tokens
The library never logs raw `transaction.token` (StoreKit `transactionId` / Google `purchaseToken`) by default. If you wrap the logger, don't `JSON.stringify(error.cause)` blindly — `cause` may contain a network response with the token. Strip token-shaped strings before sending to your observability backend.
:::

## What `iap.initialize()` can throw

Surprisingly little. `initialize()` is designed to be **resilient** because failing init breaks every consumer's app boot.

Scenarios:

- Native plugin missing → logs warning, sets web-stub mode, init succeeds.
- Backend unreachable during background refresh → swallowed, emitted via `error` event, init succeeds.
- Storage read fails → logs error, in-memory state is empty, init succeeds.
- `INVALID_CONFIG` → throws at `createIAP()` call (synchronous), never reaches `initialize()`.

So `await iap.initialize()` should very rarely throw in practice. The few cases that DO throw are coding errors (calling `initialize()` after `destroy()`).

## What `iap.purchase()` can throw

`purchase()` does NOT throw on user-cancellation, pending, or verification failure — those are surfaced via the `PurchaseResult` discriminated union (`status: 'cancelled' | 'pending' | 'verification_failed' | 'failed'`).

It DOES throw on:

- `INVALID_CONFIG` (productId not in `config.products`)
- `NOT_INITIALIZED`
- `ALREADY_IN_PROGRESS` (concurrent purchase for same productId)
- `PLATFORM_NOT_SUPPORTED` (web)
- `INVALID_APP_USER_ID` (`appUserId` not a UUID v4)
- `APP_USER_ID_FETCH_FAILED` (async fetcher threw / rejected; original attached as `cause`)

These are programming errors / pre-flight failures, not user-flow errors — surface them in dev, silence them in production (the user can't fix them).

## Permanent vs transient classification (recovery) {#permanent-vs-transient-classification}

When recovery runs at `initialize()` time, every entry in the
unfinished-transactions list is re-verified with your backend. The
backend's response shape is `{ valid: true, ... }` or
`{ valid: false, error: string, message?: string }`. Before v0.4.0,
*every* `valid:false` was retained for retry on the next launch — fine
for transient backend hiccups, but pathological for **permanent**
domain failures like `TRANSACTION_NOT_FOUND` (Apple/Google has no
record of this transactionId), where retrying achieves nothing and
hammers your backend on every app resume.

From v0.4.0, recovery classifies the `error` code against
`options.permanentErrorCodes`:

- **In the set** → drop the entry (best-effort `acknowledge()` to
  clear the platform queue, then `unfinished.remove()`, then emit
  `'recovery-dropped-permanent'`).
- **Not in the set** → retain (legacy behavior — retry on next
  launch).

Default set:

```ts
import { DEFAULT_PERMANENT_ERROR_CODES } from '@nosslabs/iap';
// ['TRANSACTION_NOT_FOUND', 'PRODUCT_MISMATCH']
```

Extend with your backend's custom permanent codes:

```ts
createIAP({
  options: {
    permanentErrorCodes: [...DEFAULT_PERMANENT_ERROR_CODES, 'MY_BACKEND_CODE'],
  },
});
```

Disable entirely (revert to retry-forever):

```ts
createIAP({
  options: { permanentErrorCodes: [] },
});
```

Listen for drops via the new event for ops observability:

```ts
iap.on('recovery-dropped-permanent', ({ productId, error, message }) => {
  console.warn(`[iap] dropped permanently-invalid tx for ${productId}: ${error}`, { message });
});
```

The default codes match the documented contract used by Attesto's
[backend recipes](https://attesto.nossdev.com/recipes/) — both
`TRANSACTION_NOT_FOUND` and `PRODUCT_MISMATCH` are answers, not
infrastructure failures (they're returned with HTTP 200 +
`valid:false`, never as 5xx). Codes deliberately excluded from the
default set: `STALE_TRANSACTION` (sometimes legitimately retryable),
`SIGNATURE_INVALID` (Apple cert rotation has caused historical false
positives), and any `INVALID_REQUEST` (caller bug — shouldn't fire
from recovery, which resends previously-valid request shapes).

::: warning Backend lag assumption
The default set assumes your backend queries Apple App Store Server
API / Google Play Developer API with eventually-consistent reads
(typical for Attesto's recipe pattern). If your backend reads from a
replicated database with replication lag exceeding app-launch cadence,
a `TRANSACTION_NOT_FOUND` response could be transient — in that case
configure `permanentErrorCodes: []` (or a custom set) until the lag is
reconciled.
:::

## Next

- [Events](/v5/guide/events) — full event reference
- [Backend contract](/v5/guide/backend-contract) — what your backend returns on each path
- [`IAPError` API](/v5/api/errors) — full type reference
