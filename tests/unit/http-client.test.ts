import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HttpClient } from '../../src/adapters/backend/http-client.js';
import { IAPError, IAPErrorCode } from '../../src/lib/errors.js';
import { jsonResponse, makeSilentLogger } from '../mocks/http-helpers.js';

const silentLogger = makeSilentLogger();

const okSchema = z.object({ ok: z.boolean() });
type OkBody = z.infer<typeof okSchema>;

function makeClient(
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
): HttpClient {
  return new HttpClient({
    baseUrl: 'https://api.example.com',
    getAuthHeaders: async () => ({ Authorization: 'Bearer test-token' }),
    timeoutMs: 5_000,
    retries: 2,
    logger: silentLogger,
    ...overrides,
  });
}

describe('HttpClient — happy path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes a GET request with auth headers and parses the JSON body', async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = makeClient({ fetch: fetchStub });

    const result = await client.request<OkBody>(
      { method: 'GET', path: '/iap/entitlements' },
      okSchema,
    );

    expect(result).toEqual({ ok: true });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const call = fetchStub.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(url).toBe('https://api.example.com/iap/entitlements');
    expect((init as RequestInit).method).toBe('GET');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
    expect(headers['content-type']).toBe('application/json');
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = makeClient({ fetch: fetchStub, baseUrl: 'https://api.example.com/' });
    await client.request({ method: 'GET', path: '/x' }, okSchema);
    expect(fetchStub.mock.calls[0]?.[0]).toBe('https://api.example.com/x');
  });

  it('serializes the body for POST', async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = makeClient({ fetch: fetchStub });
    await client.request({ method: 'POST', path: '/x', body: { a: 1 } }, okSchema);
    const init = fetchStub.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('runs requestTransform before sending', async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = makeClient({
      fetch: fetchStub,
      requestTransform: (req) => ({ ...req, path: `/transformed${req.path}` }),
    });
    await client.request({ method: 'GET', path: '/orig' }, okSchema);
    expect(fetchStub.mock.calls[0]?.[0]).toBe('https://api.example.com/transformed/orig');
  });

  it('runs responseTransform before validation', async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse({ wrapped: { ok: true } }));
    const client = makeClient({
      fetch: fetchStub,
      responseTransform: (raw) => (raw as { wrapped: unknown }).wrapped,
    });
    const result = await client.request<OkBody>({ method: 'GET', path: '/x' }, okSchema);
    expect(result).toEqual({ ok: true });
  });
});

describe('HttpClient — error mapping', () => {
  it('maps 401 → BACKEND_AUTH_FAILED (not retried)', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const client = makeClient({ fetch: fetchStub, retries: 3 });
    await expect(client.request({ method: 'GET', path: '/x' }, okSchema)).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_AUTH_FAILED,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('maps 403 → BACKEND_AUTH_FAILED (not retried)', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    const client = makeClient({ fetch: fetchStub, retries: 3 });
    await expect(client.request({ method: 'GET', path: '/x' }, okSchema)).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_AUTH_FAILED,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('maps 400 → BACKEND_BAD_RESPONSE non-recoverable (not retried)', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
    const client = makeClient({ fetch: fetchStub, retries: 3 });
    try {
      await client.request({ method: 'GET', path: '/x' }, okSchema);
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.BACKEND_BAD_RESPONSE);
      expect((error as IAPError).recoverable).toBe(false);
    }
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('maps 404 → BACKEND_BAD_RESPONSE non-recoverable', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const client = makeClient({ fetch: fetchStub, retries: 3 });
    await expect(client.request({ method: 'GET', path: '/x' }, okSchema)).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_BAD_RESPONSE,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('rejects 204 No Content with BACKEND_BAD_RESPONSE (not misleading JSON error)', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    );
    const client = makeClient({ fetch: fetchStub });
    try {
      await client.request({ method: 'GET', path: '/iap/entitlements' }, okSchema);
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(IAPError);
      expect((error as IAPError).code).toBe(IAPErrorCode.BACKEND_BAD_RESPONSE);
      expect((error as IAPError).message).toMatch(/empty body/);
      expect((error as IAPError).message).toMatch(/iap\/entitlements/);
    }
  });

  it('rejects 200 with content-length:0 with BACKEND_BAD_RESPONSE', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response('', {
        status: 200,
        headers: { 'content-length': '0' },
      }),
    );
    const client = makeClient({ fetch: fetchStub });
    await expect(client.request({ method: 'GET', path: '/x' }, okSchema)).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_BAD_RESPONSE,
    });
  });

  it('rejects with BACKEND_BAD_RESPONSE if response is not JSON', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValue(
        new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    const client = makeClient({ fetch: fetchStub });
    await expect(client.request({ method: 'GET', path: '/x' }, okSchema)).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_BAD_RESPONSE,
    });
  });

  it('rejects when response fails zod validation', async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse({ ok: 'not-a-bool' }));
    const client = makeClient({ fetch: fetchStub });
    await expect(client.request({ method: 'GET', path: '/x' }, okSchema)).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_BAD_RESPONSE,
    });
  });
});

describe('HttpClient — retry behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries on 500 and eventually succeeds', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = makeClient({ fetch: fetchStub, retries: 2 });

    const promise = client.request<OkBody>({ method: 'GET', path: '/x' }, okSchema);
    // Advance time past both backoffs (1s + 2s) plus epsilon.
    await vi.advanceTimersByTimeAsync(3_500);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it('retries on 408 and 429', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 408 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = makeClient({ fetch: fetchStub, retries: 2 });

    const promise = client.request<OkBody>({ method: 'GET', path: '/x' }, okSchema);
    await vi.advanceTimersByTimeAsync(3_500);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 400/404 etc', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const client = makeClient({ fetch: fetchStub, retries: 3 });

    await expect(client.request({ method: 'GET', path: '/x' }, okSchema)).rejects.toBeInstanceOf(
      IAPError,
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('gives up after retries are exhausted', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const client = makeClient({ fetch: fetchStub, retries: 2 });

    const promise = client.request({ method: 'GET', path: '/x' }, okSchema);
    promise.catch(() => {}); // prevent unhandled rejection during fake-time advance
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_UNAVAILABLE,
      recoverable: true,
    });
    // 1 initial attempt + 2 retries = 3
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it('retries on network error (fetch rejects)', async () => {
    const fetchStub = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = makeClient({ fetch: fetchStub, retries: 1 });

    const promise = client.request<OkBody>({ method: 'GET', path: '/x' }, okSchema);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});

describe('HttpClient — timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('aborts fetch after timeoutMs and maps to BACKEND_TIMEOUT', async () => {
    const fetchStub = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const client = makeClient({ fetch: fetchStub, timeoutMs: 1_000, retries: 0 });

    const promise = client.request({ method: 'GET', path: '/x' }, okSchema);
    promise.catch(() => {}); // prevent unhandled rejection
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(promise).rejects.toMatchObject({
      code: IAPErrorCode.BACKEND_TIMEOUT,
      recoverable: true,
    });
  });
});
