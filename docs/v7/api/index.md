# API reference

Hand-curated reference for the `7.x` (Capacitor 7) line.

## Modules

| Page | Contents |
|---|---|
| [`createIAP`](/v7/api/create-iap) | Factory function; entry point |
| [`IAP` instance](/v7/api/iap-instance) | All instance methods |
| [Types](/v7/api/types) | `Product`, `EntitlementBase`, `NativeTransaction`, `VerifiedTransaction`, `PurchaseResult`, `RestoreResult` |
| [Errors](/v7/api/errors) | `IAPError`, `IAPErrorCode`, `errorHint`, `isIAPError` |
| [`BackendAdapter`](/v7/api/backend-adapter) | Interface for custom transports |
| [Events reference](/v7/api/events-reference) | `EventMap`, `EventName`, `EventPayload`, `Unsubscribe` |

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
  type Storefront,
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
