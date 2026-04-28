import { describe, expect, it } from 'vitest';
import { IAPError, IAPErrorCode, errorHint, isIAPError } from '../../src/lib/errors.js';

describe('IAPError', () => {
  it('captures code, message, and cause; appends remediation hint by default', () => {
    const cause = new Error('underlying');
    const error = new IAPError({
      code: IAPErrorCode.STORE_ERROR,
      message: 'Store error',
      cause,
    });
    expect(error.code).toBe(IAPErrorCode.STORE_ERROR);
    expect(error.message).toContain('Store error');
    // Hint is auto-appended unless includeHint:false
    expect(error.message).toContain('Hint:');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('IAPError');
  });

  it('omits hint when includeHint:false', () => {
    const error = new IAPError({
      code: IAPErrorCode.STORE_ERROR,
      message: 'Plain message',
      includeHint: false,
    });
    expect(error.message).toBe('Plain message');
    expect(error.message).not.toContain('Hint:');
  });

  it('marks transient backend codes as recoverable by default', () => {
    expect(
      new IAPError({ code: IAPErrorCode.BACKEND_TIMEOUT, message: 'timeout' }).recoverable,
    ).toBe(true);
    expect(
      new IAPError({
        code: IAPErrorCode.BACKEND_UNAVAILABLE,
        message: 'unavailable',
      }).recoverable,
    ).toBe(true);
  });

  it('marks fatal codes as non-recoverable by default', () => {
    expect(new IAPError({ code: IAPErrorCode.INVALID_CONFIG, message: 'bad' }).recoverable).toBe(
      false,
    );
    expect(
      new IAPError({
        code: IAPErrorCode.PLATFORM_NOT_SUPPORTED,
        message: 'web',
      }).recoverable,
    ).toBe(false);
    expect(
      new IAPError({
        code: IAPErrorCode.VERIFICATION_REJECTED,
        message: 'rejected',
      }).recoverable,
    ).toBe(false);
  });

  it('honors explicit recoverable override', () => {
    const error = new IAPError({
      code: IAPErrorCode.INVALID_CONFIG,
      message: 'bad',
      recoverable: true,
    });
    expect(error.recoverable).toBe(true);
  });

  it('isIAPError narrows correctly', () => {
    const error = new IAPError({ code: IAPErrorCode.STORE_ERROR, message: 'x' });
    expect(isIAPError(error)).toBe(true);
    expect(isIAPError(new Error('plain'))).toBe(false);
    expect(isIAPError('string')).toBe(false);
    expect(isIAPError(null)).toBe(false);
  });

  it('preserves prototype chain through Error subclassing', () => {
    const error = new IAPError({ code: IAPErrorCode.STORE_ERROR, message: 'x' });
    expect(error).toBeInstanceOf(IAPError);
    expect(error).toBeInstanceOf(Error);
  });

  it('errorHint() returns a non-empty string for every code', () => {
    for (const code of Object.values(IAPErrorCode)) {
      const hint = errorHint(code);
      expect(typeof hint).toBe('string');
      expect(hint.length).toBeGreaterThan(0);
    }
  });

  it('errorHint() text actually appears in thrown error messages', () => {
    const e = new IAPError({
      code: IAPErrorCode.BACKEND_AUTH_FAILED,
      message: 'auth failed',
    });
    expect(e.message).toContain(errorHint(IAPErrorCode.BACKEND_AUTH_FAILED));
  });
});
