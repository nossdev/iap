export { createIAP, type IAP } from './createIAP.js';
export { DEFAULT_PERMANENT_ERROR_CODES } from './core/recovery-flow.js';
export { IAPError, IAPErrorCode, errorHint, isIAPError } from './lib/errors.js';
export { VERSION } from './version.js';

export type {
  IAPConfig,
  IAPConfigInput,
  VerificationConfig,
  BackendConfig,
  BackendConfigInput,
  StorageConfig,
  OptionsConfig,
} from './types/config.js';

export type {
  ConfiguredProduct,
  Product,
  ProductType,
  SubscriptionOffer,
  SubscriptionOfferPayment,
  SubscriptionOfferType,
} from './types/product.js';

export type { Storefront } from './types/storefront.js';

export type {
  EntitlementBase,
  DefaultEntitlement,
} from './types/entitlement.js';

export type {
  NativeTransaction,
  SubscriptionRenewal,
  SubscriptionState,
  VerifiedTransaction,
  Platform,
} from './types/transaction.js';

export type {
  AppUserId,
  AppUserIdFetcherContext,
  PurchaseOptions,
  PurchaseResult,
  RestoreResult,
  StorePurchase,
} from './types/results.js';

export type {
  EventMap,
  EventName,
  EventPayload,
  Unsubscribe,
} from './types/events.js';

export type { Logger, LogLevel } from './lib/logger.js';

// Backend layer (Phase 3) — consumers building a custom transport implement
// BackendAdapter and pass it via config.backend.adapter. The default HTTP
// implementation is also exported for advanced use (e.g. custom test setups).
export type {
  BackendAdapter,
  RestoreRequest,
  RestoreRequestTransaction,
  RestoreResponse,
  VerifyAppleRequest,
  VerifyGoogleRequest,
  VerifyResponse,
} from './adapters/backend/types.js';
export { HttpBackendAdapter, HttpClient } from './adapters/backend/index.js';

// On-device verification (local mode).
//
// `LocalVerificationAdapter` itself is deliberately NOT exported: its
// options require a `NativeAdapter`, which is internal and which a consumer
// has no way to obtain, so the export would be unusable. `verification:
// { mode: 'local' }` is how you get one. These two are for a consumer who
// would rather write their own `BackendAdapter` around the same checks.
export { isExpired, verifyPurchaseOnDevice } from './core/local-verification.js';
export type {
  LocalVerification,
  LocalVerificationError,
  LocalVerificationOptions,
  LocallyVerifiedPurchase,
  PurchaseAssurance,
} from './core/local-verification.js';
export type { HttpRequest } from './adapters/backend/http-client.js';
