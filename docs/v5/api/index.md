# API reference

Hand-curated reference for v0.1.x. Auto-generated docs ship in v0.2 (TypeDoc).

## Modules

| Page | Contents |
|---|---|
| [`createIAP`](/v5/api/create-iap) | Factory function; entry point |
| [`IAP` instance](/v5/api/iap-instance) | All instance methods |
| [Types](/v5/api/types) | `Product`, `EntitlementBase`, `NativeTransaction`, `VerifiedTransaction`, `PurchaseResult`, `RestoreResult` |
| [Errors](/v5/api/errors) | `IAPError`, `IAPErrorCode`, `errorHint`, `isIAPError` |
| [`BackendAdapter`](/v5/api/backend-adapter) | Interface for custom transports |
| [Events reference](/v5/api/events-reference) | `EventMap`, `EventName`, `EventPayload`, `Unsubscribe` |

## Top-level exports

```typescript
import {
  // Factory
  createIAP,
  type IAP,

  // Errors
  IAPError,
  IAPErrorCode,
  isIAPError,

  // Config
  type IAPConfig,
  type IAPConfigInput,
  type BackendConfig,
  type BackendConfigInput,
  type StorageConfig,
  type OptionsConfig,

  // Domain types
  type ConfiguredProduct,
  type Product,
  type ProductType,
  type EntitlementBase,
  type DefaultEntitlement,
  type NativeTransaction,
  type VerifiedTransaction,
  type Platform,
  type PurchaseResult,
  type RestoreResult,

  // Events
  type EventMap,
  type EventName,
  type EventPayload,
  type Unsubscribe,

  // Logging
  type Logger,
  type LogLevel,

  // Backend (advanced)
  type BackendAdapter,
  type RestoreRequest,
  type RestoreRequestTransaction,
  type VerifyAppleRequest,
  type VerifyGoogleRequest,
  type VerifyResponse,
  HttpBackendAdapter,
  HttpClient,
  type HttpRequest,

  // Version
  VERSION,
} from '@nosslabs/iap';
```

## Stability

- **Stable** — `createIAP`, `IAP` interface methods, all `EntitlementBase` / `Product` / `PurchaseResult` / `RestoreResult` types, every `IAPErrorCode` value, every event in `EventMap`. These follow semver.
- **Stable but advanced** — `BackendAdapter`, `HttpBackendAdapter`, `HttpClient`. Public so non-HTTP transports can be implemented; we reserve the right to add new methods to `BackendAdapter` in minor versions (additive only).
- **Internal** — anything not listed in `src/index.ts` is private. Don't import from deep paths.
