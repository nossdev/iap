import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../../src/adapters/storage/memory-adapter.js';

describe('MemoryAdapter', () => {
  it('returns null for missing keys', async () => {
    const adapter = new MemoryAdapter('ns');
    expect(await adapter.get('missing')).toBeNull();
  });

  it('roundtrips set/get', async () => {
    const adapter = new MemoryAdapter('ns');
    await adapter.set('foo', '{"a":1}');
    expect(await adapter.get('foo')).toBe('{"a":1}');
  });

  it('removes a key', async () => {
    const adapter = new MemoryAdapter('ns');
    await adapter.set('foo', 'value');
    await adapter.remove('foo');
    expect(await adapter.get('foo')).toBeNull();
  });

  it('clears every key under its namespace', async () => {
    const adapter = new MemoryAdapter('ns');
    await adapter.set('a', '1');
    await adapter.set('b', '2');
    await adapter.clear();
    expect(await adapter.get('a')).toBeNull();
    expect(await adapter.get('b')).toBeNull();
  });

  it('isolates namespaces — distinct instances do not share keys', async () => {
    const a = new MemoryAdapter('ns_a');
    const b = new MemoryAdapter('ns_b');
    await a.set('shared', 'A-value');
    await b.set('shared', 'B-value');
    expect(await a.get('shared')).toBe('A-value');
    expect(await b.get('shared')).toBe('B-value');
  });
});
