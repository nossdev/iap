export const IAPErrorCode = {
  // Configuration
  INVALID_CONFIG: 'INVALID_CONFIG',
  NOT_INITIALIZED: 'NOT_INITIALIZED',

  // Native plugin
  PLATFORM_NOT_SUPPORTED: 'PLATFORM_NOT_SUPPORTED',
  BILLING_NOT_AVAILABLE: 'BILLING_NOT_AVAILABLE',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  USER_CANCELLED: 'USER_CANCELLED',
  PURCHASE_PENDING: 'PURCHASE_PENDING',
  ALREADY_PURCHASED: 'ALREADY_PURCHASED',
  STORE_ERROR: 'STORE_ERROR',
  UNACKNOWLEDGED_PENDING: 'UNACKNOWLEDGED_PENDING',

  // Concurrency
  ALREADY_IN_PROGRESS: 'ALREADY_IN_PROGRESS',

  // Backend
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
  BACKEND_TIMEOUT: 'BACKEND_TIMEOUT',
  BACKEND_AUTH_FAILED: 'BACKEND_AUTH_FAILED',
  /** Backend reachable but the response was rejected (non-transient 4xx other
   *  than auth, malformed JSON, schema violation, 204 No Content on a JSON
   *  endpoint). Fix the request shape or the backend; do not retry. */
  BACKEND_BAD_RESPONSE: 'BACKEND_BAD_RESPONSE',
  VERIFICATION_REJECTED: 'VERIFICATION_REJECTED',

  // Storage
  STORAGE_ERROR: 'STORAGE_ERROR',
} as const;

export type IAPErrorCode = (typeof IAPErrorCode)[keyof typeof IAPErrorCode];

const RECOVERABLE_CODES = new Set<IAPErrorCode>([
  IAPErrorCode.BACKEND_UNAVAILABLE,
  IAPErrorCode.BACKEND_TIMEOUT,
  IAPErrorCode.STORAGE_ERROR,
  IAPErrorCode.UNACKNOWLEDGED_PENDING,
]);

export interface IAPErrorOptions {
  code: IAPErrorCode;
  message: string;
  cause?: unknown;
  recoverable?: boolean;
}

export class IAPError extends Error {
  readonly code: IAPErrorCode;
  readonly recoverable: boolean;
  override readonly cause?: unknown;

  constructor(options: IAPErrorOptions) {
    super(options.message);
    this.name = 'IAPError';
    this.code = options.code;
    this.cause = options.cause;
    this.recoverable = options.recoverable ?? RECOVERABLE_CODES.has(options.code);

    Object.setPrototypeOf(this, IAPError.prototype);
  }
}

export function isIAPError(error: unknown): error is IAPError {
  return error instanceof IAPError;
}
