import { defineConfig } from 'vitest/config';
import { version } from './package.json';

// The `define` below mirrors tsup.config.ts. Vitest imports `src/` directly
// rather than the bundled output, so without it `__PKG_VERSION__` would be
// undefined under test.

export default defineConfig({
  define: {
    __PKG_VERSION__: JSON.stringify(version),
  },
  test: {
    globals: true,
    // jsdom (not node): @capacitor/preferences' web fallback reads
    // window.localStorage, and createIAP integration tests exercise it.
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', '**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
