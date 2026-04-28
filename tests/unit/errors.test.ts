import { describe, expect, it } from 'vitest';
import { IAPError, IAPErrorCode, isIAPError } from '../../src/lib/errors.js';

describe('IAPError', () => {
  it('captures code, message, and cause', () => {
    const cause = new Error('underlying');
    const error = new IAPError({
      code: IAPErrorCode.STORE_ERROR,
      message: 'Store error',
      cause,
    });
    expect(error.code).toBe(IAPErrorCode.STORE_ERROR);
    expect(error.message).toBe('Store error');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('IAPError');
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
});
