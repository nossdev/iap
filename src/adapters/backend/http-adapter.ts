import { IAPError, IAPErrorCode } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { BackendConfig } from '../../types/config.js';
import type { EntitlementBase } from '../../types/entitlement.js';
import { HttpClient } from './http-client.js';
import {
  type BackendAdapter,
  type RestoreRequest,
  type VerifyAppleRequest,
  type VerifyGoogleRequest,
  type VerifyResponse,
  entitlementsResponseSchema,
  verifyResponseSchema,
} from './types.js';

export interface HttpBackendAdapterOptions {
  baseUrl: string;
  endpoints: {
    verifyApple: string;
    verifyGoogle: string;
    entitlements: string;
    restore: string;
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
    const result = await this.http.request(
      { method: 'POST', path: this.endpoints.verifyApple, body: req },
      verifyResponseSchema,
    );
    return result as VerifyResponse<TEntitlement>;
  }

  async verifyGoogle(req: VerifyGoogleRequest): Promise<VerifyResponse<TEntitlement>> {
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

  async restore(req: RestoreRequest): Promise<VerifyResponse<TEntitlement>> {
    if (req.transactions.length === 0) {
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message: 'restore() called with an empty transactions array.',
      });
    }
    const result = await this.http.request(
      { method: 'POST', path: this.endpoints.restore, body: req },
      verifyResponseSchema,
    );
    return result as VerifyResponse<TEntitlement>;
  }
}
