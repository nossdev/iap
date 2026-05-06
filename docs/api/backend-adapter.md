# `BackendAdapter`

Interface for the backend transport layer. The default `HttpBackendAdapter` covers HTTP/JSON; implement this interface yourself if your backend uses a different transport (GraphQL, gRPC-web, Firebase Functions, Supabase Edge Functions, etc.).

## Interface

```typescript
interface BackendAdapter<TEntitlement extends EntitlementBase = EntitlementBase> {
  verifyApple(req: VerifyAppleRequest):  Promise<VerifyResponse<TEntitlement>>;
  verifyGoogle(req: VerifyGoogleRequest): Promise<VerifyResponse<TEntitlement>>;
  getEntitlements():                      Promise<TEntitlement[]>;
  restore(req: RestoreRequest):           Promise<RestoreResponse<TEntitlement>>;
  /** Optional: return the SKU manifest the app should register. */
  listProducts?():                        Promise<ConfiguredProduct[]>;
}
```

## Request types

### `VerifyAppleRequest`

```typescript
interface VerifyAppleRequest {
  productId: string;
  /** Apple StoreKit transactionId (numeric string) */
  transactionId: string;
  type: ProductType;
}
```

### `VerifyGoogleRequest`

```typescript
interface VerifyGoogleRequest {
  productId: string;
  /** Google Play purchaseToken (long opaque string) */
  purchaseToken: string;
  /** App package name, e.g. 'com.example.app' */
  packageName: string;
  type: ProductType;
}
```

### `RestoreRequest`

```typescript
type RestoreRequestTransaction =
  | { platform: 'apple';  productId: string; transactionId: string }
  | { platform: 'google'; productId: string; purchaseToken: string; packageName: string };

interface RestoreRequest {
  transactions: RestoreRequestTransaction[];
}
```

## Response types

### `VerifyResponse<T>`

Used by `verifyApple` and `verifyGoogle`.

```typescript
type VerifyResponse<T extends EntitlementBase = EntitlementBase> =
  | {
      valid: true;
      transaction: { id: string; productId: string; expiresAt?: string | null };
      entitlements: T[];
    }
  | {
      valid: false;
      error: string;       // stable machine-readable code
      message?: string;    // human-readable detail
    };
```

### `RestoreResponse<T>`

Used by `restore`. Identical to `VerifyResponse` except the success branch has **no required `transaction` echo** — the library never reads it on the restore path.

```typescript
type RestoreResponse<T extends EntitlementBase = EntitlementBase> =
  | { valid: true; entitlements: T[] }
  | { valid: false; error: string; message?: string };
```

Backends that include a `transaction` (or any other extra fields) on either response shape ride through unmodified — the library validates only the named fields above and preserves everything else via Zod `.passthrough()`. Consumers can cast the resolved value to their own type to read backend-defined extras.

`getEntitlements` returns the entitlement array directly (no per-transaction verdict).

### `listProducts()` (optional)

When implemented, the library calls this during `initialize()` if the consumer omitted `products` from `createIAP()` config. Lets the backend curate the SKU manifest at runtime.

```typescript
listProducts?(): Promise<ConfiguredProduct[]>;
```

Returned shape per entry:

```typescript
type ConfiguredProduct = {
  id: string;                                       // store identifier
  type: 'subscription' | 'product' | 'consumable';
  androidPlanId?: string;                           // optional; Android multi-plan only
};
```

The library validates the response against the same schema used at config-parse time. Malformed entries throw `IAPError(BACKEND_BAD_RESPONSE)` and `initialize()` rejects.

::: warning Pre-registration is non-negotiable
Every `id` MUST already be registered in App Store Connect AND Google Play Console for the platforms you ship on. The backend manifest is a curated subset of pre-registered SKUs, not a registration.
:::

## Error semantics

Adapter implementations MUST throw `IAPError` with the appropriate code on failure. The orchestrator branches on `IAPError.recoverable` to decide whether to retry or abort.

| Condition | Code | Recoverable? |
|---|---|---|
| Network unreachable / 5xx | `BACKEND_UNAVAILABLE` | yes |
| Timeout | `BACKEND_TIMEOUT` | yes |
| 401 / 403 | `BACKEND_AUTH_FAILED` | no |
| Other 4xx, malformed JSON, schema fail | `BACKEND_BAD_RESPONSE` | no |
| Backend explicitly returned `valid: false` | Surface as `VerifyResponse` (don't throw) | n/a |

::: warning Don't throw on `valid: false`
The orchestrator distinguishes "backend rejected the receipt" from "backend was unreachable" — return the `valid: false` shape rather than throwing. Throw only on transport / parsing failures.
:::

## Example: Firebase Functions adapter

```typescript
import { httpsCallable } from 'firebase/functions';
import { IAPError, IAPErrorCode } from '@nossdev/iap';
import type {
  BackendAdapter,
  VerifyAppleRequest,
  VerifyGoogleRequest,
  RestoreRequest,
  VerifyResponse,
  EntitlementBase,
} from '@nossdev/iap';

import type { AppEntitlement } from './services/iap';

export class FirebaseBackendAdapter implements BackendAdapter<AppEntitlement> {
  constructor(private readonly functions: Functions) {}

  async verifyApple(req: VerifyAppleRequest) {
    return this.callFn<VerifyResponse<AppEntitlement>>('iapVerifyApple', req);
  }

  async verifyGoogle(req: VerifyGoogleRequest) {
    return this.callFn<VerifyResponse<AppEntitlement>>('iapVerifyGoogle', req);
  }

  async getEntitlements(): Promise<AppEntitlement[]> {
    const result = await this.callFn<{ entitlements: AppEntitlement[] }>('iapEntitlements', {});
    return result.entitlements;
  }

  async restore(req: RestoreRequest) {
    return this.callFn<VerifyResponse<AppEntitlement>>('iapRestore', req);
  }

  private async callFn<R>(name: string, payload: unknown): Promise<R> {
    try {
      const fn = httpsCallable<unknown, R>(this.functions, name);
      const result = await fn(payload);
      return result.data;
    } catch (error: any) {
      // Firebase wraps errors in HttpsError with .code
      if (error.code === 'unauthenticated') {
        throw new IAPError({ code: IAPErrorCode.BACKEND_AUTH_FAILED, message: error.message, cause: error });
      }
      if (error.code === 'unavailable' || error.code === 'deadline-exceeded') {
        throw new IAPError({ code: IAPErrorCode.BACKEND_UNAVAILABLE, message: error.message, cause: error });
      }
      throw new IAPError({ code: IAPErrorCode.BACKEND_BAD_RESPONSE, message: error.message, cause: error });
    }
  }
}
```

Then in your `createIAP` config:

```typescript
const iap = createIAP<AppEntitlement>({
  products: [/* ... */],
  backend: {
    adapter: new FirebaseBackendAdapter(functions),
    timeoutMs: 15_000,
    retries: 2,
  },
});
```

When `adapter` is provided, `baseUrl` / `endpoints` / `getAuthHeaders` are not used (and may be omitted).

## Example: Supabase Edge Functions adapter

Same pattern, different transport:

```typescript
import { SupabaseClient } from '@supabase/supabase-js';
import { IAPError, IAPErrorCode } from '@nossdev/iap';
import type { BackendAdapter, /* ... */ } from '@nossdev/iap';

export class SupabaseBackendAdapter implements BackendAdapter<AppEntitlement> {
  constructor(private readonly supabase: SupabaseClient) {}

  async verifyApple(req: VerifyAppleRequest) {
    const { data, error } = await this.supabase.functions.invoke('iap-verify-apple', { body: req });
    if (error) {
      throw new IAPError({
        code: IAPErrorCode.BACKEND_UNAVAILABLE,
        message: error.message,
        cause: error,
      });
    }
    return data as VerifyResponse<AppEntitlement>;
  }

  // ... verifyGoogle, getEntitlements, restore identically
}
```

## Built-in: `HttpBackendAdapter`

The library exports the default HTTP implementation for advanced use:

```typescript
import { HttpBackendAdapter, HttpClient } from '@nossdev/iap';
```

You typically don't import these — `createIAP` constructs them automatically when you pass `baseUrl` + `endpoints`. The named export exists so test setups can construct one manually with a mocked `HttpClient`.

## See also

- [Backend contract](/guide/backend-contract) — wire-format reference
- [Configuration](/guide/configuration#custom-transport) — how to wire in your adapter
- [Errors](/api/errors) — `IAPError` shape your adapter throws
