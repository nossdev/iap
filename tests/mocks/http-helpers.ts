import { vi } from 'vitest';

/**
 * A no-op logger suitable for unit tests where log output would be noise.
 * Each method is a fresh spy so individual tests can assert on calls if needed.
 */
export function makeSilentLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Build a minimal `Response` that returns `body` as JSON.
 *
 * @param body - JSON-serializable value returned as the response body.
 * @param status - HTTP status code (default 200).
 * @param statusText - HTTP status text (default 'OK').
 */
export function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}
