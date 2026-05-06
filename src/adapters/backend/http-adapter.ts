import { IAPError, IAPErrorCode } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { BackendConfig } from '../../types/config.js';
import type { EntitlementBase } from '../../types/entitlement.js';
import type { ConfiguredProduct } from '../../types/product.js';
import { HttpClient } from './http-client.js';
import {
  type BackendAdapter,
  type RestoreRequest,
  type RestoreResponse,
  type VerifyAppleRequest,
  type VerifyGoogleRequest,
  type VerifyResponse,
  entitlementsResponseSchema,
  productManifestResponseSchema,
  restoreResponseSchema,
  verifyResponseSchema,
} from './types.js';

export interface HttpBackendAdapterOptions {
  baseUrl: string;
  endpoints: {
    /**
     * Optional. Required only when the consumer's app actually invokes
     * `verifyApple` (iOS purchases). Android-only configs may omit it; the
     * adapter throws `INVALID_CONFIG` if `verifyApple()` is called without
     * this set. At least one of `verifyApple` or `verifyGoogle` must be set
     * for any usable config.
     */
    verifyApple?: string;
    /**
     * Optional. Required only when the consumer's app actually invokes
     * `verifyGoogle` (Android purchases). iOS-only configs may omit it; the
     * adapter throws `INVALID_CONFIG` if `verifyGoogle()` is called without
     * this set. At least one of `verifyApple` or `verifyGoogle` must be set
     * for any usable config.
     */
    verifyGoogle?: string;
    entitlements: string;
    restore: string;
    products?: string;
  };
  getAuthHeaders: () => Record<string, string> | Promise<Record<string, string>>;
  requestTransform?: BackendConfig['requestTransform'];
  responseTransform?: BackendConfig['responseTransform'];
  timeoutMs: number;
  retries: number;
  fetch?: typeof fetch;
  logger: Logger;
}

/**
 * Default `BackendAdapter` implementation: HTTP/JSON via `fetch`.
 *
 * The four methods translate to HTTP calls against the consumer's backend:
 * - `verifyApple` → POST `endpoints.verifyApple`
 * - `verifyGoogle` → POST `endpoints.verifyGoogle`
 * - `getEntitlements` → GET `endpoints.entitlements`
 * - `restore` → POST `endpoints.restore`
 *
 * The recommended request/response shape mirrors Attesto's normalized
 * transaction one hop downstream (see PLAN.md §5.8). Consumers whose
 * backend uses a different shape can supply `requestTransform` /
 * `responseTransform` to map between the library's defaults and theirs.
 */
export class HttpBackendAdapter<TEntitlement extends EntitlementBase = EntitlementBase>
  implements BackendAdapter<TEntitlement>
{
  private readonly http: HttpClient;
  private readonly endpoints: HttpBackendAdapterOptions['endpoints'];

  constructor(opts: HttpBackendAdapterOptions) {
    this.endpoints = opts.endpoints;
    const httpClientOpts: ConstructorParameters<typeof HttpClient>[0] = {
      baseUrl: opts.baseUrl,
      getAuthHeaders: opts.getAuthHeaders,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      logger: opts.logger,
      ...(opts.requestTransform ? { requestTransform: opts.requestTransform } : {}),
      ...(opts.responseTransform ? { responseTransform: opts.responseTransform } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    };
    this.http = new HttpClient(httpClientOpts);
  }

  async verifyApple(req: VerifyAppleRequest): Promise<VerifyResponse<TEntitlement>> {
    if (!this.endpoints.verifyApple) {
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message:
          'HttpBackendAdapter.verifyApple() requires backend.endpoints.verifyApple to be configured. Set it on iOS-supporting builds, or skip Apple purchases on this build.',
      });
    }
    const result = await this.http.request(
      { method: 'POST', path: this.endpoints.verifyApple, body: req },
      verifyResponseSchema,
    );
    return result as VerifyResponse<TEntitlement>;
  }

  async verifyGoogle(req: VerifyGoogleRequest): Promise<VerifyResponse<TEntitlement>> {
    if (!this.endpoints.verifyGoogle) {
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message:
          'HttpBackendAdapter.verifyGoogle() requires backend.endpoints.verifyGoogle to be configured. Set it on Android-supporting builds, or skip Google purchases on this build.',
      });
    }
    const result = await this.http.request(
      { method: 'POST', path: this.endpoints.verifyGoogle, body: req },
      verifyResponseSchema,
    );
    return result as VerifyResponse<TEntitlement>;
  }

  async getEntitlements(): Promise<TEntitlement[]> {
    const result = await this.http.request(
      { method: 'GET', path: this.endpoints.entitlements },
      entitlementsResponseSchema,
    );
    return result.entitlements as TEntitlement[];
  }

  async restore(req: RestoreRequest): Promise<RestoreResponse<TEntitlement>> {
    // Empty-array guard lives in `RestoreOrchestrator` (transport-agnostic);
    // see Phase 3 review L7. If a consumer calls this adapter directly with
    // an empty list, the backend's response is whatever it returns — usually
    // a 400 the HttpClient surfaces as `BACKEND_BAD_RESPONSE`.
    const result = await this.http.request(
      { method: 'POST', path: this.endpoints.restore, body: req },
      restoreResponseSchema,
    );
    return result as RestoreResponse<TEntitlement>;
  }

  async listProducts(): Promise<ConfiguredProduct[]> {
    if (!this.endpoints.products) {
      // Defensive: createIAP only calls listProducts() when this is set, but
      // a consumer who reaches into the adapter directly gets a clear error.
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message:
          'HttpBackendAdapter.listProducts() requires backend.endpoints.products to be configured.',
      });
    }
    const result = await this.http.request(
      { method: 'GET', path: this.endpoints.products },
      productManifestResponseSchema,
    );
    return result.products;
  }
}
