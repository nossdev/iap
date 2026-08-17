/**
 * Build-time constants substituted by the bundler. Declared here so `src/`
 * type-checks without importing package.json (which would drag it into the
 * emitted declarations and change `rootDir`).
 */
declare const __PKG_VERSION__: string;
