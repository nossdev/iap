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

  // appUserId pre-attach
  /**
   * The supplied `appUserId` (literal or fetcher-returned) is not a valid
   * UUID v4. Apple requires a UUID for `appAccountToken`; we enforce the
   * same constraint cross-platform for a consistent contract.
   */
  INVALID_APP_USER_ID: 'INVALID_APP_USER_ID',
  /**
   * The async `appUserId` fetcher threw or rejected. Original error is
   * attached as `cause` so the caller can introspect (network failure,
   * backend 5xx, etc.).
   */
  APP_USER_ID_FETCH_FAILED: 'APP_USER_ID_FETCH_FAILED',
} as const;

export type IAPErrorCode = (typeof IAPErrorCode)[keyof typeof IAPErrorCode];

const RECOVERABLE_CODES = new Set<IAPErrorCode>([
  IAPErrorCode.BACKEND_UNAVAILABLE,
  IAPErrorCode.BACKEND_TIMEOUT,
  IAPErrorCode.STORAGE_ERROR,
  IAPErrorCode.UNACKNOWLEDGED_PENDING,
]);

/**
 * Per-code remediation hints. Each line answers "what does the consumer
 * usually need to check or change to resolve this?" — short enough to
 * append to a thrown error's message without burying the original detail.
 *
 * Style: imperative, action-first, ends with a period. No links (those
 * live in the docs; consumers grep for the code and find them).
 */
const HINTS: Readonly<Record<IAPErrorCode, string>> = {
  // Configuration
  INVALID_CONFIG:
    'Check the field paths reported above against the IAPConfig schema (see /api/types).',
  NOT_INITIALIZED:
    'Call iap.initialize() before this method, or recreate the instance after destroy().',

  // Native plugin
  PLATFORM_NOT_SUPPORTED:
    'In-app purchases run on iOS/Android only. Web is no-op by design — guard your purchase UI behind Capacitor.isNativePlatform().',
  BILLING_NOT_AVAILABLE:
    'The store billing service is unavailable. Confirm @capgo/native-purchases is installed and `npx cap sync` has run; check the device sandbox/test account is signed in.',
  PRODUCT_NOT_FOUND:
    'Ensure the productId is registered in App Store Connect / Play Console AND in your createIAP({ products }) config.',
  USER_CANCELLED: 'No action needed — the user dismissed the native purchase sheet.',
  PURCHASE_PENDING:
    'Android only: payment is awaiting external clearance (e.g. cash payment, bank verification). The backend will receive a Google RTDN webhook when it clears; call iap.refresh() afterward.',
  ALREADY_PURCHASED:
    'The user already owns this non-consumable. Use iap.restorePurchases() to re-grant entitlement, or query iap.hasEntitlement(key) before showing the purchase CTA.',
  STORE_ERROR:
    'Native store reported an error. Check device connectivity, sandbox account state, and the cause field for the underlying plugin error.',
  UNACKNOWLEDGED_PENDING:
    'A Google purchase has been unacknowledged for >2 days and is at risk of auto-refund. Verify the backend can be reached and call iap.refresh() to retry acknowledgement.',

  // Concurrency
  ALREADY_IN_PROGRESS:
    'Await the in-flight iap.purchase(productId) before starting another for the same product.',

  // Backend
  BACKEND_UNAVAILABLE:
    'Backend is unreachable or returning 5xx. Retry will happen automatically per config.retries; if persistent, check your server.',
  BACKEND_TIMEOUT:
    'Backend did not respond within timeoutMs. Increase config.backend.timeoutMs or check server response time.',
  BACKEND_AUTH_FAILED:
    'Backend returned 401/403. Check that getAuthHeaders() returns a valid Bearer token and that the backend recognizes it.',
  BACKEND_BAD_RESPONSE:
    'Backend response did not match the expected shape. Confirm /api/iap/* endpoints follow the contract documented at /guide/backend-contract.',
  VERIFICATION_REJECTED:
    'Backend rejected the transaction (valid:false). The transaction stays in unfinished_transactions for retry; the user may have switched accounts or the receipt may be invalid.',

  // Storage
  STORAGE_ERROR:
    'Capacitor Preferences write failed. Check device storage availability; the in-memory state is still updated, only persistence failed.',

  // appUserId pre-attach
  INVALID_APP_USER_ID:
    'appUserId must be a UUID v4 (e.g. crypto.randomUUID()). Apple requires this for appAccountToken; we enforce the same on Android for consistency.',
  APP_USER_ID_FETCH_FAILED:
    'The async appUserId fetcher threw or rejected. Inspect the cause field for the underlying error (network failure, backend non-2xx, parse failure).',
};

/** Public accessor for the hint text — exported so docs / consumer error UIs can render it. */
export function errorHint(code: IAPErrorCode): string {
  return HINTS[code];
}

export interface IAPErrorOptions {
  code: IAPErrorCode;
  message: string;
  cause?: unknown;
  recoverable?: boolean;
  /**
   * Whether to append the per-code remediation hint to the message.
   * Defaults to `true`. Set `false` only if the caller already includes a
   * hint in `message` (avoids double-tagging).
   */
  includeHint?: boolean;
}

export class IAPError extends Error {
  readonly code: IAPErrorCode;
  readonly recoverable: boolean;
  override readonly cause?: unknown;

  constructor(options: IAPErrorOptions) {
    const hint = options.includeHint === false ? '' : (HINTS[options.code] ?? '');
    const fullMessage = hint ? `${options.message}\n\nHint: ${hint}` : options.message;
    super(fullMessage);
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

/**
 * Coerce an unknown thrown value into an `IAPError`.
 *
 * - If `error` is already an `IAPError`, return it unchanged (preserves
 *   the original code, recoverable flag, and cause chain).
 * - Otherwise wrap with the supplied fallback `code` and `message` and
 *   attach the original as `cause`.
 *
 * Used by orchestrators and adapters that catch `unknown` from the JS
 * runtime and need to surface a typed error without losing context.
 */
export function toIAPError(
  error: unknown,
  fallbackMessage: string,
  fallbackCode: IAPErrorCode,
): IAPError {
  if (isIAPError(error)) return error;
  return new IAPError({
    code: fallbackCode,
    message: fallbackMessage,
    cause: error,
  });
}
