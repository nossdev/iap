import { describe, expect, it } from 'vitest';
import { readJwsClaims } from '../../src/lib/jws.js';

/** base64url-encode a UTF-8 string, the way Apple encodes a JWS segment. */
function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJws(payload: unknown): string {
  return [
    base64Url(JSON.stringify({ alg: 'ES256', x5c: ['…'] })),
    base64Url(JSON.stringify(payload)),
    'c2lnbmF0dXJl',
  ].join('.');
}

/**
 * `readJwsClaims` decodes the payload segment of StoreKit 2's
 * `jwsRepresentation` for its *data* — it performs no signature check and
 * must never be mistaken for one. Apple's signature has already been
 * verified natively before the transaction reaches the WebView (capgo only
 * resolves a `VerificationResult.verified`), so the claims are trustworthy
 * by provenance, not because this function checked anything.
 */
describe('readJwsClaims', () => {
  it('reads the claims out of a well-formed JWS', () => {
    const jws = makeJws({ originalTransactionId: '2000001043762129', productId: 'premium' });
    expect(readJwsClaims(jws)).toEqual({
      originalTransactionId: '2000001043762129',
      productId: 'premium',
    });
  });

  it('decodes base64url without padding, including - and _ substitutions', () => {
    // A payload engineered to produce both URL-safe substitutions, so a
    // plain atob() on the raw segment would throw or mis-decode.
    const payload = { note: 'ÿÿÿ>?>?', originalTransactionId: '1' };
    const jws = makeJws(payload);
    const segment = jws.split('.')[1] ?? '';
    expect(segment).toMatch(/[-_]/);
    expect(segment).not.toContain('=');
    expect(readJwsClaims(jws)).toEqual(payload);
  });

  it('decodes multi-byte UTF-8 in a claim value', () => {
    // A naive atob()-to-string decode mangles anything above U+00FF.
    const jws = makeJws({ productId: 'プレミアム' });
    expect(readJwsClaims(jws)).toEqual({ productId: 'プレミアム' });
  });

  it('returns null when the payload is not a JSON object', () => {
    // A JWS whose payload is a bare array or string is well-formed base64
    // but useless as claims; callers index into the result by name.
    expect(readJwsClaims(makeJws(['a', 'b']))).toBeNull();
    expect(readJwsClaims(makeJws('a string'))).toBeNull();
    expect(readJwsClaims(makeJws(42))).toBeNull();
    expect(readJwsClaims(makeJws(null))).toBeNull();
  });

  it('returns null for a segment count that is not three', () => {
    expect(readJwsClaims('onlyonesegment')).toBeNull();
    expect(readJwsClaims('two.segments')).toBeNull();
    expect(readJwsClaims('a.b.c.d')).toBeNull();
  });

  it('returns null when the payload segment is not valid base64', () => {
    expect(readJwsClaims('aaaa.!!!not-base64!!!.cccc')).toBeNull();
  });

  it('returns null when the payload segment is not JSON', () => {
    expect(readJwsClaims(`aaaa.${base64Url('this is not json')}.cccc`)).toBeNull();
  });

  it('returns null for an empty payload segment', () => {
    expect(readJwsClaims('aaaa..cccc')).toBeNull();
  });

  it('returns null when the payload decodes to bytes that are not UTF-8', () => {
    // "__4" is base64url for [0xFF, 0xFE] — valid base64, not valid UTF-8.
    // Decoding leniently would yield replacement characters and a confusing
    // JSON parse error; strict decoding makes it one clean "not claims".
    expect(readJwsClaims('aaaa.__4.cccc')).toBeNull();
  });

  it('never throws on input it was not promised', () => {
    // The value crosses a native bridge; treat every shape as hostile.
    for (const input of ['', '...', undefined, null, 42, {}, []] as unknown[]) {
      expect(() => readJwsClaims(input as string)).not.toThrow();
      expect(readJwsClaims(input as string)).toBeNull();
    }
  });
});
