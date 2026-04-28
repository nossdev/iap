import type { Logger } from '../lib/logger.js';

export interface AppResumeListenerOptions {
  logger: Logger;
  /** Called whenever the app becomes active. Return value is awaited but
   *  never propagated — failures are logged via `logger.warn`. */
  onResume: () => void | Promise<void>;
}

export interface AppResumeListenerHandle {
  remove(): Promise<void>;
}

/**
 * Attach an `App.addListener('appStateChange')` listener via `@capacitor/app`
 * so the library can refresh entitlements when the app returns from
 * background. `@capacitor/app` is an OPTIONAL peer dep — when consumers
 * disable `options.refreshOnResume`, they don't have to install it.
 *
 * Returns `null` when `@capacitor/app` is unavailable or the runtime
 * cannot register the listener (e.g. web). Call sites should treat null
 * as "no listener attached" and continue.
 */
export async function attachAppResumeListener(
  opts: AppResumeListenerOptions,
): Promise<AppResumeListenerHandle | null> {
  let mod: typeof import('@capacitor/app');
  try {
    mod = await import('@capacitor/app');
  } catch (error) {
    opts.logger.warn(
      'refreshOnResume requested but @capacitor/app is not installed; resume listener disabled.',
      error,
    );
    return null;
  }

  let handle: { remove(): Promise<void> };
  try {
    handle = await mod.App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      void Promise.resolve(opts.onResume()).catch((error) => {
        opts.logger.warn('refreshOnResume handler threw.', error);
      });
    });
  } catch (error) {
    opts.logger.warn(
      'Failed to attach App appStateChange listener; resume refresh disabled.',
      error,
    );
    return null;
  }

  return {
    async remove() {
      try {
        await handle.remove();
      } catch (error) {
        opts.logger.warn('Failed to remove App appStateChange listener.', error);
      }
    },
  };
}
