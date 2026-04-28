export { createIAP, type IAP } from './createIAP.js';
export { IAPError, IAPErrorCode, isIAPError } from './lib/errors.js';
export { VERSION } from './version.js';

export type {
  IAPConfig,
  IAPConfigInput,
  BackendConfig,
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
