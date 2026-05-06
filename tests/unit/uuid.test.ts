import { describe, expect, it } from 'vitest';
import { isValidUuidV4 } from '../../src/lib/uuid.js';

describe('isValidUuidV4', () => {
  it('accepts canonical lowercase UUID v4', () => {
    expect(isValidUuidV4('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('accepts canonical uppercase UUID v4', () => {
    expect(isValidUuidV4('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('accepts result of crypto.randomUUID() (v4 by spec)', () => {
    // Smoke test: crypto.randomUUID() is the expected source for callers,
    // so the validator must always say yes to its output. Run a few to
    // catch any edge in the variant nibble.
    for (let i = 0; i < 8; i++) {
      expect(isValidUuidV4(crypto.randomUUID())).toBe(true);
    }
  });

  it('rejects nil UUID (all zeros has version=0, not 4)', () => {
    expect(isValidUuidV4('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('rejects v1 UUID (version nibble = 1)', () => {
    // Version-nibble check: v4 requires the 13th hex digit to be `4`.
    expect(isValidUuidV4('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });

  it('rejects v3 / v5 UUIDs (wrong version nibbles)', () => {
    expect(isValidUuidV4('550e8400-e29b-31d4-a716-446655440000')).toBe(false);
    expect(isValidUuidV4('550e8400-e29b-51d4-a716-446655440000')).toBe(false);
  });

  it('rejects malformed shapes', () => {
    expect(isValidUuidV4('not-a-uuid')).toBe(false);
    expect(isValidUuidV4('')).toBe(false);
    expect(isValidUuidV4('550e8400e29b41d4a716446655440000')).toBe(false); // no hyphens
    expect(isValidUuidV4('550e8400-e29b-41d4-a716')).toBe(false); // truncated
  });

  it('rejects surrounding whitespace (caller must trim)', () => {
    expect(isValidUuidV4(' 550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isValidUuidV4('550e8400-e29b-41d4-a716-446655440000 ')).toBe(false);
    expect(isValidUuidV4('\n550e8400-e29b-41d4-a716-446655440000\n')).toBe(false);
  });

  it('rejects wrong variant nibble (must be 8/9/a/b at position 17)', () => {
    // Variant nibble check: v4 requires the 17th hex digit ∈ {8, 9, a, b}.
    expect(isValidUuidV4('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
    expect(isValidUuidV4('550e8400-e29b-41d4-2716-446655440000')).toBe(false);
  });
});
