import { describe, expect, it } from 'vitest';
import { isValidUuid } from '../../src/lib/uuid.js';

/**
 * iap accepts any RFC 9562 UUID as an `appUserId`, not only v4.
 *
 * The constraint comes from Apple: `appAccountToken` must be a UUID, which
 * Apple validates server-side. Google's `obfuscatedAccountId` accepts any
 * string up to 64 chars, but iap enforces the UUID shape on both platforms
 * so consumers have one predictable contract.
 *
 * Any *version* is allowed because deterministic identifiers are a
 * legitimate and common choice: a UUIDv5 over a stable name gives the same
 * binding on every device without storing a mapping, and v7 is the current
 * recommendation for time-ordered ids. Restricting to v4 forced consumers to
 * invent a second identifier and keep the two in step.
 */
describe('isValidUuid', () => {
  it('accepts every RFC 9562 version', () => {
    // One canonical example per version nibble 1-8, all with an RFC 9562
    // variant nibble (8, 9, a or b).
    const byVersion = {
      1: '550e8400-e29b-11d4-a716-446655440000',
      2: '550e8400-e29b-21d4-a716-446655440000',
      3: '550e8400-e29b-31d4-a716-446655440000',
      4: '550e8400-e29b-41d4-a716-446655440000',
      5: '550e8400-e29b-51d4-a716-446655440000',
      6: '550e8400-e29b-61d4-a716-446655440000',
      7: '0190e7b4-1f8a-7c3e-8f21-446655440000',
      8: '550e8400-e29b-81d4-a716-446655440000',
    };
    for (const [version, uuid] of Object.entries(byVersion)) {
      expect(isValidUuid(uuid), `version ${version}`).toBe(true);
    }
  });

  it('accepts a real UUIDv5, which is what a deterministic binding looks like', () => {
    // uuidv5('household@example.test', <namespace>) — the Wren pattern.
    expect(isValidUuid('74738ff5-5367-5958-9aee-98fffdcd1876')).toBe(true);
  });

  it('accepts the output of crypto.randomUUID()', () => {
    for (let i = 0; i < 8; i++) {
      expect(isValidUuid(crypto.randomUUID())).toBe(true);
    }
  });

  it('accepts either case', () => {
    expect(isValidUuid('550E8400-E29B-51D4-A716-446655440000')).toBe(true);
    expect(isValidUuid('550e8400-e29b-51d4-a716-446655440000')).toBe(true);
  });

  it('accepts every RFC 9562 variant nibble', () => {
    for (const variant of ['8', '9', 'a', 'b', 'A', 'B']) {
      expect(isValidUuid(`550e8400-e29b-51d4-${variant}716-446655440000`)).toBe(true);
    }
  });

  it('rejects the nil and max UUIDs', () => {
    // Both are valid RFC 9562 constructs, and both deliberately carry no
    // version or variant — they mean "no identifier". Passing one as a
    // binding would bind a purchase to nothing while looking well-formed.
    expect(isValidUuid('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(isValidUuid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(false);
  });

  it('rejects a version nibble outside 1-8', () => {
    expect(isValidUuid('550e8400-e29b-01d4-a716-446655440000')).toBe(false);
    expect(isValidUuid('550e8400-e29b-91d4-a716-446655440000')).toBe(false);
    expect(isValidUuid('550e8400-e29b-f1d4-a716-446655440000')).toBe(false);
  });

  it('rejects a non-RFC variant nibble', () => {
    // 0-7 is the legacy NCS range and c-f is Microsoft/reserved; neither is
    // an RFC 9562 UUID, and Apple rejects them.
    for (const variant of ['0', '7', 'c', 'f']) {
      expect(isValidUuid(`550e8400-e29b-51d4-${variant}716-446655440000`)).toBe(false);
    }
  });

  it('rejects anything that is not a canonical UUID', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid('550e8400e29b51d4a716446655440000')).toBe(false); // no hyphens
    expect(isValidUuid('550e8400-e29b-51d4-a716')).toBe(false); // truncated
    expect(isValidUuid('550e8400-e29b-51d4-a716-446655440000-extra')).toBe(false);
    expect(isValidUuid(' 550e8400-e29b-51d4-a716-446655440000')).toBe(false); // leading space
    expect(isValidUuid('550e8400-e29b-51d4-a716-446655440000 ')).toBe(false); // trailing
    expect(isValidUuid('550e8400-e29b-51d4-a716-44665544000g')).toBe(false); // non-hex
    expect(isValidUuid('{550e8400-e29b-51d4-a716-446655440000}')).toBe(false); // braced
    expect(isValidUuid('urn:uuid:550e8400-e29b-51d4-a716-446655440000')).toBe(false);
  });

  it('never throws on a value that is not a string', () => {
    for (const input of [undefined, null, 42, {}, []] as unknown[]) {
      expect(() => isValidUuid(input as string)).not.toThrow();
      expect(isValidUuid(input as string)).toBe(false);
    }
  });
});
