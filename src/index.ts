export { createIAP, type IAP } from './createIAP.js';
export { IAPError, IAPErrorCode, isIAPError } from './lib/errors.js';
export { VERSION } from './version.js';

export type {
  IAPConfig,
  IAPConfigInput,
  BackendConfig,
  BackendConfigInput,
  StorageConfig,
  OptionsConfig,
} from './types/config.js';

export type { ConfiguredProduct, Product, ProductType } from './types/product.js';

export type {
  EntitlementBase,
  DefaultEntitlement,
} from './types/entitlement.js';

export type {
  NativeTransaction,
  VerifiedTransaction,
  Platform,
} from './types/transaction.js';

export type {
  PurchaseResult,
  RestoreResult,
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
  VerifyAppleRequest,
  VerifyGoogleRequest,
  VerifyResponse,
} from './adapters/backend/types.js';
export { HttpBackendAdapter, HttpClient } from './adapters/backend/index.js';
export type { HttpRequest } from './adapters/backend/http-client.js';
