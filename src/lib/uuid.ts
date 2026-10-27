/**
 * RFC 9562 UUID validator.
 *
 * Apple's `appAccountToken` on a StoreKit purchase MUST be a UUID — Apple
 * validates it server-side and rejects anything else. Google's
 * `obfuscatedAccountId` accepts any string up to 64 characters, but iap
 * enforces the UUID shape on both platforms so consumers have one
 * predictable contract.
 *
 * **Any version (1-8) is accepted**, not only v4. Deterministic identifiers
 * are a legitimate and common choice: a UUIDv5 over a stable name yields the
 * same binding on every device with no mapping to store, and v7 is the
 * current recommendation for time-ordered ids. Restricting to v4 forced
 * consumers who already had a deterministic identity to mint a second one
 * and keep the two in step.
 *
 * What is still refused:
 *
 * - **The nil and max UUIDs.** Both are valid RFC 9562 constructs and both
 *   deliberately carry no version or variant — they mean "no identifier".
 *   Accepting one would bind a purchase to nothing while looking
 *   well-formed, which is worse than a clear rejection.
 * - **Non-RFC variants.** The variant nibble must be 8, 9, a or b. The
 *   0-7 range is legacy NCS and c-f is Microsoft/reserved, so neither is an
 *   RFC 9562 UUID.
 *
 * Those last two are **iap's choice, not Apple's requirement.** Foundation's
 * `UUID(uuidString:)` — what `appAccountToken` is built from — parses any
 * 36-character hyphenated hex string without checking the version or variant
 * nibbles, and accepts the nil UUID. So this validator is stricter than the
 * platform, deliberately: one spelling and one shape keeps the binding
 * comparable and keeps "is this a UUID" from meaning four different things.
 *
 * The practical cost is worth naming. An identifier that merely *looks* like
 * a UUID — an md5 digest formatted with hyphens, say — has effectively
 * random version and variant nibbles and will usually be refused here, where
 * Apple would have taken it. A proper RFC v3/v5 implementation sets both
 * nibbles, so a deterministic UUIDv5 binding is unaffected.
 * - **Non-canonical spellings.** No braces, no `urn:uuid:` prefix, no
 *   surrounding whitespace, no missing hyphens. One spelling keeps string
 *   comparison meaningful — see the note on casing below.
 *
 * **On casing:** this accepts either, because both platforms and every
 * generator in common use disagree about it. iap normalizes the binding it
 * reads back off a transaction to lowercase (StoreKit returns an uppercase
 * `uuidString`), so `StorePurchase.appUserId` compares equal to whatever was
 * passed to `purchase({ appUserId })`.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
