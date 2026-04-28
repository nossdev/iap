import { describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter } from '../../src/events/emitter.js';

describe('TypedEventEmitter', () => {
  it('invokes handlers when an event is emitted', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('purchase-started', handler);
    emitter.emit('purchase-started', { productId: 'premium' });
    expect(handler).toHaveBeenCalledWith({ productId: 'premium' });
  });

  it('supports multiple handlers per event', () => {
    const emitter = new TypedEventEmitter();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    emitter.on('purchase-started', handlerA);
    emitter.on('purchase-started', handlerB);
    emitter.emit('purchase-started', { productId: 'remove_ads' });
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  it('returns an unsubscribe function that removes the handler', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    const unsubscribe = emitter.on('purchase-started', handler);
    unsubscribe();
    emitter.emit('purchase-started', { productId: 'premium' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does nothing when emitting an event with no listeners', () => {
    const emitter = new TypedEventEmitter();
    expect(() => emitter.emit('purchase-started', { productId: 'premium' })).not.toThrow();
  });

  it('continues invoking subsequent handlers when one throws', () => {
    const emitter = new TypedEventEmitter();
    const failing = vi.fn(() => {
      throw new Error('boom');
    });
    const succeeding = vi.fn();
    emitter.on('purchase-started', failing);
    emitter.on('purchase-started', succeeding);
    emitter.emit('purchase-started', { productId: 'premium' });
    expect(failing).toHaveBeenCalled();
    expect(succeeding).toHaveBeenCalled();
  });

  it('removeAll clears every listener', () => {
    const emitter = new TypedEventEmitter();
    const handler = vi.fn();
    emitter.on('purchase-started', handler);
    expect(emitter.listenerCount('purchase-started')).toBe(1);
    emitter.removeAll();
    expect(emitter.listenerCount('purchase-started')).toBe(0);
  });
});
