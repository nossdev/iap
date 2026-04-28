import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockState {
  registeredHandler: ((state: { isActive: boolean }) => void) | null;
  throwOnAddListener: boolean;
  removeImpl: () => Promise<void>;
  addCalls: Array<[string, (state: { isActive: boolean }) => void]>;
  removeCalls: number;
}

const mockState: MockState = {
  registeredHandler: null,
  throwOnAddListener: false,
  removeImpl: async () => {},
  addCalls: [],
  removeCalls: 0,
};

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (event: string, handler: (state: { isActive: boolean }) => void) => {
      if (mockState.throwOnAddListener) throw new Error('listener registration failed');
      mockState.addCalls.push([event, handler]);
      if (event === 'appStateChange') mockState.registeredHandler = handler;
      return {
        remove: async () => {
          mockState.removeCalls += 1;
          await mockState.removeImpl();
        },
      };
    },
  },
}));

import { attachAppResumeListener } from '../../src/core/app-resume-listener.js';
import { makeSilentLogger } from '../mocks/http-helpers.js';

const logger = makeSilentLogger();

describe('attachAppResumeListener', () => {
  beforeEach(() => {
    mockState.registeredHandler = null;
    mockState.throwOnAddListener = false;
    mockState.removeImpl = async () => {};
    mockState.addCalls = [];
    mockState.removeCalls = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers an appStateChange listener', async () => {
    const handle = await attachAppResumeListener({ logger, onResume: vi.fn() });
    expect(handle).not.toBeNull();
    expect(mockState.addCalls).toHaveLength(1);
    expect(mockState.addCalls[0]?.[0]).toBe('appStateChange');
  });

  it('calls onResume when isActive=true', async () => {
    const onResume = vi.fn(async () => {});
    await attachAppResumeListener({ logger, onResume });
    if (!mockState.registeredHandler) throw new Error('handler not registered');

    mockState.registeredHandler({ isActive: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onResume when isActive=false', async () => {
    const onResume = vi.fn();
    await attachAppResumeListener({ logger, onResume });
    if (!mockState.registeredHandler) throw new Error('handler not registered');

    mockState.registeredHandler({ isActive: false });
    await new Promise((r) => setTimeout(r, 0));

    expect(onResume).not.toHaveBeenCalled();
  });

  it('swallows onResume errors via logger.warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const onResume = vi.fn(async () => {
      throw new Error('refresh failed');
    });
    await attachAppResumeListener({ logger, onResume });
    if (!mockState.registeredHandler) throw new Error('handler not registered');

    mockState.registeredHandler({ isActive: true });
    await new Promise((r) => setTimeout(r, 10));

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns null when addListener throws', async () => {
    mockState.throwOnAddListener = true;
    const handle = await attachAppResumeListener({ logger, onResume: vi.fn() });
    expect(handle).toBeNull();
  });

  it('handle.remove() forwards to the underlying handle', async () => {
    const handle = await attachAppResumeListener({ logger, onResume: vi.fn() });
    if (!handle) throw new Error('handle should not be null');
    await handle.remove();
    expect(mockState.removeCalls).toBe(1);
  });

  it('handle.remove() swallows errors', async () => {
    mockState.removeImpl = async () => {
      throw new Error('remove failed');
    };
    const handle = await attachAppResumeListener({ logger, onResume: vi.fn() });
    if (!handle) throw new Error('handle should not be null');
    await expect(handle.remove()).resolves.toBeUndefined();
  });
});
