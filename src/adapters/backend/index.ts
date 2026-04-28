import { IAPError, IAPErrorCode } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { BackendConfig } from '../../types/config.js';
import type { EntitlementBase } from '../../types/entitlement.js';
import { HttpBackendAdapter } from './http-adapter.js';
import { type BackendAdapter, isBackendAdapter } from './types.js';

export interface BackendAdapterOptions {
  config: BackendConfig;
  logger: Logger;
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
  const { config, logger, fetch: fetchImpl } = options;

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
    getAuthHeaders: config.getAuthHeaders as () =>
      | Record<string, string>
      | Promise<Record<string, string>>,
    requestTransform: config.requestTransform,
    responseTransform: config.responseTransform,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    logger,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

export { HttpBackendAdapter } from './http-adapter.js';
export { HttpClient } from './http-client.js';
export type {
  BackendAdapter,
  RestoreRequest,
  RestoreRequestTransaction,
  VerifyAppleRequest,
  VerifyGoogleRequest,
  VerifyResponse,
} from './types.js';
