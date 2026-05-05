import type { z } from 'zod';
import { IAPError, IAPErrorCode } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { redactHeaders } from '../../lib/redact.js';

export interface HttpRequest {
  method: 'GET' | 'POST';
  /**
   * Path appended to baseUrl. Leading slash is optional — both `'/foo'` and
   * `'foo'` are normalized at request time, and any trailing slash on `baseUrl`
   * is stripped, so all four corner cases produce the same joined URL.
   */
  path: string;
  /** JSON-serializable body (for POST). */
  body?: unknown;
  /** Extra headers, merged on top of auth headers + Content-Type. */
  headers?: Record<string, string>;
}

export interface HttpClientOptions {
  baseUrl: string;
  /** Called before every request. Returns headers to merge in (e.g. `{ Authorization: 'Bearer ...' }`). */
  getAuthHeaders: () => Record<string, string> | Promise<Record<string, string>>;
  /** Per-attempt timeout in ms. */
  timeoutMs: number;
  /** Number of retry attempts on transient errors (5xx, 408, 429, network). */
  retries: number;
  /** Optional pre-send transform. Lets consumer rewrite path/body/headers. */
  requestTransform?: (req: HttpRequest) => HttpRequest | Promise<HttpRequest>;
  /** Optional response transform. Runs on the parsed JSON before validation. */
  responseTransform?: (raw: unknown) => unknown | Promise<unknown>;
  /** Override `globalThis.fetch` for tests. */
  fetch?: typeof fetch;
  logger: Logger;
}

/** Backoff schedule for transient retries (ms). Caps at 4s on attempt 3+. */
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];

/**
 * Generic HTTP client for the consumer backend.
 *
 * - **Timeout**: per-attempt via `AbortController` (native fetch has no timeout option).
 * - **Retry policy**: 5xx, 408, 429, and network errors retry with exponential backoff.
 *   Other 4xx fail immediately (caller's responsibility to fix).
 * - **Auth + transforms**: `getAuthHeaders()` runs once per request; `requestTransform`
 *   and `responseTransform` are escape hatches for consumers whose backend uses a
 *   different shape than the library's default.
 * - **Logging**: requests are logged at debug level with sensitive headers redacted
 *   via `redactHeaders()` (PLAN.md §13 — never log raw bearer tokens).
 *
 * Consumers don't construct this directly — `HttpBackendAdapter` wraps it.
 */
export class HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpClientOptions) {
    const provided = opts.fetch;
    if (provided) {
      this.fetchImpl = provided;
    } else if (typeof globalThis.fetch === 'function') {
      this.fetchImpl = globalThis.fetch.bind(globalThis);
    } else {
      throw new IAPError({
        code: IAPErrorCode.INVALID_CONFIG,
        message: 'globalThis.fetch is unavailable; pass a fetch implementation via config.',
      });
    }
  }

  /**
   * Execute the request and parse the response with the given zod schema.
   * Returns the validated, transformed result.
   */
  async request<T>(req: HttpRequest, schema: z.ZodType<T>): Promise<T> {
    const transformed = this.opts.requestTransform ? await this.opts.requestTransform(req) : req;

    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const path = transformed.path.startsWith('/') ? transformed.path : `/${transformed.path}`;
    const url = `${base}${path}`;
    const auth = await this.opts.getAuthHeaders();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...auth,
      ...(transformed.headers ?? {}),
    };

    let lastError: IAPError | undefined;
    const maxAttempts = this.opts.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.singleAttempt<T>(url, transformed, headers, schema);
      } catch (error) {
        if (!(error instanceof IAPError) || !error.recoverable) {
          throw error;
        }
        lastError = error;
        const remaining = maxAttempts - attempt;
        if (remaining <= 0) break;
        const delayMs =
          RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 4_000;
        this.opts.logger.debug(
          `HTTP ${transformed.method} ${transformed.path} retry ${attempt}/${this.opts.retries} after ${delayMs}ms (${error.code})`,
        );
        await sleep(delayMs);
      }
    }
    throw (
      lastError ??
      new IAPError({
        code: IAPErrorCode.BACKEND_UNAVAILABLE,
        message: 'Backend request failed with no recorded error.',
      })
    );
  }

  private async singleAttempt<T>(
    url: string,
    req: HttpRequest,
    headers: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    this.opts.logger.debug(`HTTP ${req.method} ${req.path}`, { headers: redactHeaders(headers) });

    let response: Response;
    try {
      response = await this.fetchWithTimeout(url, {
        method: req.method,
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
    } catch (cause) {
      // AbortError → timeout; everything else → network error.
      const isAbort = (cause as { name?: string } | null)?.name === 'AbortError';
      throw new IAPError({
        code: isAbort ? IAPErrorCode.BACKEND_TIMEOUT : IAPErrorCode.BACKEND_UNAVAILABLE,
        message: isAbort
          ? `Backend request timed out after ${this.opts.timeoutMs}ms.`
          : 'Network error while calling backend.',
        cause,
        recoverable: true,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new IAPError({
        code: IAPErrorCode.BACKEND_AUTH_FAILED,
        message: `Backend auth failed (${response.status}).`,
      });
    }

    if (!response.ok) {
      const transient =
        response.status === 408 || response.status === 429 || response.status >= 500;
      throw new IAPError({
        // Transient failures (5xx, 408, 429) → BACKEND_UNAVAILABLE so the
        // retry loop picks them up. Non-transient (other 4xx after auth has
        // been ruled out) → BACKEND_BAD_RESPONSE so the orchestrator can
        // surface "fix the request" rather than "try again later".
        code: transient ? IAPErrorCode.BACKEND_UNAVAILABLE : IAPErrorCode.BACKEND_BAD_RESPONSE,
        message: `Backend returned ${response.status} ${response.statusText}.`,
        recoverable: transient,
      });
    }

    // 204 No Content on a JSON endpoint is a contract violation — PLAN.md §5.8
    // defines explicit JSON shapes for every endpoint, so we fail loudly with
    // a precise error rather than the misleading "not valid JSON" path below.
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      throw new IAPError({
        code: IAPErrorCode.BACKEND_BAD_RESPONSE,
        message: `Backend returned ${response.status} with empty body; expected JSON for ${req.path}.`,
      });
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (cause) {
      throw new IAPError({
        code: IAPErrorCode.BACKEND_BAD_RESPONSE,
        message: 'Backend response was not valid JSON.',
        cause,
      });
    }

    const transformed = this.opts.responseTransform ? await this.opts.responseTransform(raw) : raw;

    const parsed = schema.safeParse(transformed);
    if (!parsed.success) {
      throw new IAPError({
        code: IAPErrorCode.BACKEND_BAD_RESPONSE,
        message: `Backend response failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
