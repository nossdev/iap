/**
 * Library version, injected at build time from `package.json` (see the
 * `define` in tsup.config.ts, mirrored in vitest.config.ts).
 *
 * Exported for consumers to read — nothing inside the library consumes it. (An
 * earlier comment claimed the logger stamped it onto error reports; it never
 * did. `src/lib/logger.ts` uses a fixed `[@nosslabs/iap]` prefix.)
 */
export const VERSION: string = __PKG_VERSION__;
