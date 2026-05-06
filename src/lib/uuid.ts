/**
 * RFC 4122 v4 UUID validator.
 *
 * Apple's `appAccountToken` field on a StoreKit purchase MUST be a UUID
 * (Apple validates server-side and rejects non-UUIDs). Google's
 * `obfuscatedAccountId` accepts any string up to 64 chars, but iap
 * enforces UUID v4 on both platforms to give consumers a single,
 * predictable contract.
 *
 * Strict v4: rejects v1/v3/v5 UUIDs (different version nibbles), nil UUID,
 * surrounding whitespace, and non-canonical lengths. The version nibble
 * (`4xxx`) and variant nibble (`[89ab]xxx`) match the RFC 4122 v4 spec.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuidV4(value: string): boolean {
  return UUID_V4_REGEX.test(value);
}
