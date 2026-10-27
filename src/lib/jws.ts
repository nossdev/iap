/**
 * Reads the claims out of the payload segment of a JWS (JSON Web Signature).
 *
 * Used for one thing: StoreKit 2's `jwsRepresentation`, which carries fields
 * the plugin does not surface as its own — most importantly
 * `originalTransactionId`, the purchase reference that survives renewals
 * (`transactionId` does not).
 *
 * **This performs no cryptographic verification, and must never be mistaken
 * for one.** It decodes; it does not check. That is sound here only because
 * of where the value comes from: `@capgo/native-purchases` resolves a
 * purchase solely for a StoreKit 2 `VerificationResult.verified`, so Apple's
 * signature check has already run in native code before the JWS reaches the
 * WebView. The claims are trustworthy by provenance.
 *
 * It follows that this must not be used on a JWS from anywhere else — a
 * value a consumer received over the network, say. For that, the signature
 * has to be verified server-side against Apple's certificate chain, which is
 * what the backend / Attesto path is for.
 *
 * Never log the return value: a JWS payload is receipt data (PLAN.md §16).
 */

/** Decode a base64url segment to a UTF-8 string, or `null` if it will not. */
function decodeBase64UrlSegment(segment: string): string | null {
  // base64url → base64, then restore the padding atob() requires.
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }

  // atob() yields one char per byte; anything above U+00FF in the original
  // JSON would be mangled by reading that string directly, so round-trip
  // through the bytes.
  try {
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Return the JWS payload's claims as a plain object, or `null` when the
 * input is not a JWS carrying a JSON object payload.
 *
 * Total by design — every malformed, truncated, non-base64, non-JSON or
 * non-object input resolves to `null` rather than throwing, because the
 * value crosses a native bridge and a bad one must never break a purchase.
 */
export function readJwsClaims(jws: string): Record<string, unknown> | null {
  if (typeof jws !== 'string' || jws.length === 0) return null;

  const segments = jws.split('.');
  if (segments.length !== 3) return null;

  const payload = segments[1];
  if (!payload) return null;

  const json = decodeBase64UrlSegment(payload);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  // Callers index the result by claim name, so an array or a primitive is
  // no more useful than nothing.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  return parsed as Record<string, unknown>;
}
