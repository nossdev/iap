import { describe, expect, it } from 'vitest';
import { maskToken, redactHeaders } from '../../src/lib/redact.js';

describe('maskToken', () => {
  it('masks long tokens to first 8 chars + ellipsis', () => {
    expect(maskToken('GPA.1234-5678-9012-34567')).toBe('GPA.1234…');
    expect(maskToken('2000000123456789')).toBe('20000001…');
  });

  it('returns short tokens unchanged (no privacy gain)', () => {
    expect(maskToken('short')).toBe('short');
    expect(maskToken('exactly8')).toBe('exactly8'); // 8 chars: not masked
  });

  it('returns empty string for empty/null/undefined input', () => {
    expect(maskToken('')).toBe('');
    expect(maskToken(null)).toBe('');
    expect(maskToken(undefined)).toBe('');
  });

  it('masks just past the threshold', () => {
    expect(maskToken('123456789')).toBe('12345678…');
  });
});

describe('redactHeaders', () => {
  it('preserves non-sensitive headers verbatim', () => {
    const result = redactHeaders({
      'Content-Type': 'application/json',
      'X-Trace-Id': 'trace-abc-123',
      Accept: 'application/json',
    });
    expect(result).toEqual({
      'Content-Type': 'application/json',
      'X-Trace-Id': 'trace-abc-123',
      Accept: 'application/json',
    });
  });

  it('masks Authorization Bearer tokens but keeps the scheme', () => {
    const result = redactHeaders({
      Authorization: 'Bearer abc123def456ghi789',
    });
    expect(result.Authorization).toBe('Bearer abc123de…');
  });

  it('masks Basic auth credentials', () => {
    const result = redactHeaders({
      Authorization: 'Basic dXNlcjpwYXNzd29yZA==',
    });
    expect(result.Authorization).toBe('Basic dXNlcjpw…');
  });

  it('masks Cookie header', () => {
    const result = redactHeaders({
      Cookie: 'session=abc123def456ghi789',
    });
    expect(result.Cookie).toBe('session=…');
  });

  it('masks X-Api-Key header (case-insensitive)', () => {
    const result = redactHeaders({
      'x-api-key': 'sk_live_1234567890abcdef',
    });
    expect(result['x-api-key']).toBe('sk_live_…');
  });

  it('case-insensitive match: AUTHORIZATION is also redacted', () => {
    const result = redactHeaders({
      AUTHORIZATION: 'Bearer abc123def456',
    });
    expect(result.AUTHORIZATION).toBe('Bearer abc123de…');
  });

  it('does not mutate the input', () => {
    const input = { Authorization: 'Bearer secret-token-12345' };
    redactHeaders(input);
    expect(input.Authorization).toBe('Bearer secret-token-12345');
  });
});
