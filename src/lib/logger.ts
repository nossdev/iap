export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const PREFIX = '[@nosslabs/iap]';

/**
 * Default logger that writes to console at or above the configured level.
 * Consumers can pass a custom logger (Sentry, Datadog, etc.) via config.
 */
export function createDefaultLogger(level: LogLevel): Logger {
  const minPriority = LEVEL_PRIORITY[level];
  const enabled = (l: LogLevel) => LEVEL_PRIORITY[l] <= minPriority;

  return {
    error(message, ...args) {
      if (enabled('error')) console.error(PREFIX, message, ...args);
    },
    warn(message, ...args) {
      if (enabled('warn')) console.warn(PREFIX, message, ...args);
    },
    info(message, ...args) {
      if (enabled('info')) console.info(PREFIX, message, ...args);
    },
    debug(message, ...args) {
      if (enabled('debug')) console.debug(PREFIX, message, ...args);
    },
  };
}

export function isLogger(value: unknown): value is Logger {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Logger>;
  return (
    typeof candidate.error === 'function' &&
    typeof candidate.warn === 'function' &&
    typeof candidate.info === 'function' &&
    typeof candidate.debug === 'function'
  );
}
