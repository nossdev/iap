# Errors

```typescript
import { IAPError, IAPErrorCode, isIAPError, errorHint } from '@nossdev/iap';
```

## `IAPError`

```typescript
class IAPError extends Error {
  readonly code: IAPErrorCode;
  readonly recoverable: boolean;
  override readonly cause?: unknown;

  constructor(options: {
    code: IAPErrorCode;
    message: string;
    cause?: unknown;
    recoverable?: boolean;
    /** Default true. Set false if `message` already includes a hint. */
    includeHint?: boolean;
  });
}
```

The single error class the library throws. Subclass of `Error` — survives JSON serialization (lossily) and works with `instanceof`.

### Properties

| Property | Type | Description |
|---|---|---|
| `code` | `IAPErrorCode` | Stable enum — switch on this |
| `message` | `string` | Description + auto-appended `\n\nHint: ...` |
| `recoverable` | `boolean` | Hint to the UI: should "try again" appear? |
| `cause` | `unknown` | Original error (network, plugin, etc.) when wrapped |
| `name` | `string` | Always `'IAPError'` |

### `recoverable` defaults

Recoverable: `BACKEND_UNAVAILABLE`, `BACKEND_TIMEOUT`, `STORAGE_ERROR`, `UNACKNOWLEDGED_PENDING`.
Non-recoverable: everything else.

Override per-throw via the constructor option.

## `IAPErrorCode`

```typescript
const IAPErrorCode = {
  // Configuration
  INVALID_CONFIG:           'INVALID_CONFIG',
  NOT_INITIALIZED:          'NOT_INITIALIZED',

  // Native plugin
  PLATFORM_NOT_SUPPORTED:   'PLATFORM_NOT_SUPPORTED',
  BILLING_NOT_AVAILABLE:    'BILLING_NOT_AVAILABLE',
  PRODUCT_NOT_FOUND:        'PRODUCT_NOT_FOUND',
  USER_CANCELLED:           'USER_CANCELLED',
  PURCHASE_PENDING:         'PURCHASE_PENDING',
  ALREADY_PURCHASED:        'ALREADY_PURCHASED',
  STORE_ERROR:              'STORE_ERROR',
  UNACKNOWLEDGED_PENDING:   'UNACKNOWLEDGED_PENDING',

  // Concurrency
  ALREADY_IN_PROGRESS:      'ALREADY_IN_PROGRESS',

  // Backend
  BACKEND_UNAVAILABLE:      'BACKEND_UNAVAILABLE',
  BACKEND_TIMEOUT:          'BACKEND_TIMEOUT',
  BACKEND_AUTH_FAILED:      'BACKEND_AUTH_FAILED',
  BACKEND_BAD_RESPONSE:     'BACKEND_BAD_RESPONSE',
  VERIFICATION_REJECTED:    'VERIFICATION_REJECTED',

  // Storage
  STORAGE_ERROR:            'STORAGE_ERROR',

  // appUserId pre-attach
  INVALID_APP_USER_ID:      'INVALID_APP_USER_ID',
  APP_USER_ID_FETCH_FAILED: 'APP_USER_ID_FETCH_FAILED',
} as const;

type IAPErrorCode = typeof IAPErrorCode[keyof typeof IAPErrorCode];
```

The enum is `as const` — value strings are stable across versions. Use `IAPErrorCode.X` rather than the raw string for refactor safety.

For per-code descriptions and remediation steps, see [Error handling guide](/guide/error-handling).

## `isIAPError`

```typescript
function isIAPError(error: unknown): error is IAPError;
```

Type guard. Use to narrow caught errors before accessing `.code` / `.recoverable`.

```typescript
try {
  await iap.refresh();
} catch (error) {
  if (isIAPError(error)) {
    // error: IAPError (narrowed)
    console.log(error.code);
  } else {
    throw error; // unexpected — rethrow
  }
}
```

## `errorHint`

```typescript
function errorHint(code: IAPErrorCode): string;
```

Returns the canonical remediation hint for a code. The same string is auto-appended to thrown error messages.

```typescript
import { errorHint, IAPErrorCode } from '@nossdev/iap';

errorHint(IAPErrorCode.BACKEND_AUTH_FAILED);
// → "Backend returned 401/403. Check that getAuthHeaders() returns a valid Bearer token..."
```

Useful for building error UIs that show the hint separately from the message:

```typescript
if (isIAPError(error)) {
  ui.showError({
    title: error.code,
    body: error.message.split('\n\nHint:')[0], // strip hint from message
    suggestion: errorHint(error.code),
  });
}
```

## Constructing an `IAPError` (advanced)

You typically don't need to construct one — the library throws. But for custom backend adapters:

```typescript
import { IAPError, IAPErrorCode } from '@nossdev/iap';

throw new IAPError({
  code: IAPErrorCode.BACKEND_BAD_RESPONSE,
  message: 'Firebase function returned unexpected shape',
  cause: originalError,
  recoverable: false,
  // includeHint: false, // set if message already has remediation text
});
```

## See also

- [Error handling guide](/guide/error-handling) — full per-code reference + UI patterns
- [`BackendAdapter`](/api/backend-adapter) — how custom adapters surface errors
