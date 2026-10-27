/**
 * Build a JWS the way Apple does, for tests that exercise
 * `src/lib/jws.ts` and the adapter's purchase-reference extraction.
 *
 * Only the payload segment is meaningful: iap decodes the claims and checks
 * no signature (see `src/lib/jws.ts` for why that is sound), so the header
 * and signature here are plausible filler.
 */

/** base64url-encode a UTF-8 string, as Apple encodes a JWS segment. */
export function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A three-segment JWS carrying `claims` as its payload. */
export function makeJws(claims: unknown): string {
  return [
    base64Url(JSON.stringify({ alg: 'ES256', x5c: ['…'] })),
    base64Url(JSON.stringify(claims)),
    'c2lnbmF0dXJl',
  ].join('.');
}
