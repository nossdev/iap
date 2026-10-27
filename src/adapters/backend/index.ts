import type { LocallyVerifiedPurchase } from '../../core/local-verification.js';
import { IAPError, IAPErrorCode } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { IAPConfig } from '../../types/config.js';
import type { EntitlementBase } from '../../types/entitlement.js';
import type { ConfiguredProduct } from '../../types/product.js';
import type { NativeAdapter } from '../native/types.js';
import { HttpBackendAdapter } from './http-adapter.js';
import { LocalVerificationAdapter } from './local-adapter.js';
import { type BackendAdapter, isBackendAdapter } from './types.js';

export interface BackendAdapterOptions {
  config: IAPConfig;
  logger: Logger;
  /**
   * Resolved lazily for local mode, which reads what the store owns. The
   * native adapter is constructed in `initialize()`, after this.
   */
  getNativeAdapter?: () => NativeAdapter | null;
  getProducts?: () => readonly ConfiguredProduct[];
  /** Current entitlements, so an ambiguous store answer preserves them. */
  getCurrentEntitlements?: () => EntitlementBase[];
  /** Test/override hook. Otherwise uses globalThis.fetch. */
  fetch?: typeof fetch;
}

/**
 * Build the active `BackendAdapter`.
 *
 * - If `config.adapter` is provided, validates the shape and returns it directly.
 * - Otherwise, builds an {@link HttpBackendAdapter} from the HTTP-specific config.
 *
 * Schema-level validation already enforces that HTTP fields are present when
 * no adapter is provided (see `backendConfigSchema.superRefine`); this
 * function still re-checks at runtime for defense-in-depth.
 */
export function selectBackendAdapter<TEntitlement extends EntitlementBase = EntitlementBase>(
  options: BackendAdapterOptions,
): BackendAdapter<TEntitlement> {
  const { config: iapConfig, logger, fetch: fetchImpl } = options;

  // Local mode: verify on the device. Still an adapter, so the purchase and
  // recovery flows above it are unchanged — see `LocalVerificationAdapter`.
  if (iapConfig.verification) {
    const verification = iapConfig.verification;
    return new LocalVerificationAdapter<TEntitlement>({
      getNativeAdapter: options.getNativeAdapter ?? (() => null),
      getProducts: options.getProducts ?? (() => iapConfig.products ?? []),
      entitlements: verification.entitlements as (
        purchase: LocallyVerifiedPurchase,
      ) => TEntitlement[],
      // Passed only when the app actually binds purchases: the adapter
      // reads "no resolver" as "no binding required", and a resolver
      // returning null as "required, but nobody is signed in".
      ...(verification.appUserId === undefined
        ? {}
        : { getAppUserId: resolveAppUserId(verification.appUserId) }),
      getCurrentEntitlements: () => (options.getCurrentEntitlements?.() ?? []) as TEntitlement[],
      graceMs: iapConfig.options.entitlementGraceMs,
      logger,
    });
  }

  const config = iapConfig.backend;
  if (!config) {
    throw new IAPError({
      code: IAPErrorCode.INVALID_CONFIG,
      message:
        'Neither backend nor verification is configured; the schema should have caught this. This is a library bug.',
    });
  }

  if (config.adapter !== undefined) {
    if (!isBackendAdapter(config.adapter)) {
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message:
          'backend.adapter must implement BackendAdapter (verifyApple, verifyGoogle, getEntitlements, restore).',
      });
    }
    return config.adapter as BackendAdapter<TEntitlement>;
  }

  // HTTP path — schema already required these fields, but re-check.
  if (!config.baseUrl || !config.endpoints || !config.getAuthHeaders) {
    throw new IAPError({
      code: IAPErrorCode.INVALID_CONFIG,
      message:
        'backend HTTP fields (baseUrl, endpoints, getAuthHeaders) are required when no custom adapter is provided.',
    });
  }

  return new HttpBackendAdapter<TEntitlement>({
    baseUrl: config.baseUrl,
    endpoints: config.endpoints,
    getAuthHeaders: config.getAuthHeaders,
    requestTransform: config.requestTransform,
    responseTransform: config.responseTransform,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    logger,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/**
 * Normalise `verification.appUserId`'s two forms into one resolver.
 *
 * The function form exists so the binding can follow the session — a fixed
 * string is captured at `createIAP()` time and is the previous user's after
 * a login change, which refuses every purchase made afterwards.
 */
function resolveAppUserId(appUserId: string | (() => string | null)): () => string | null {
  return typeof appUserId === 'function' ? appUserId : () => appUserId;
}

export { HttpBackendAdapter } from './http-adapter.js';
export { HttpClient } from './http-client.js';
