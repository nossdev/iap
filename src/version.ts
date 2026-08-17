/**
 * Library version, injected at build time from `package.json` (see the
 * `define` in tsup.config.ts, mirrored in vitest.config.ts).
 * Read at runtime by the logger so error reports include the version.
 */
export const VERSION: string = __PKG_VERSION__;
