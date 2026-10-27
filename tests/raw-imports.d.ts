/**
 * Vite features used by `native-plugin-contract.test.ts` to read the
 * installed `@capgo/native-purchases` build's own files.
 *
 * Declared here rather than pulling in `vite/client` or `@types/node` so
 * `tsconfig.json`'s `types: ["vitest/globals"]` keeps standing — src/ must
 * compile without globals that do not exist in a WebView.
 */

/** `?raw` imports a file's contents as a string. */
declare module '*?raw' {
  const contents: string;
  export default contents;
}

/**
 * `import.meta.glob` — the subset of the signature these tests use.
 *
 * Both declarations in this file are global, so `src/` also typechecks
 * against them. Neither is usable there: `import.meta.glob` is a Vite
 * transform that would not survive a consumer's bundler, and a `?raw`
 * import of a source file makes no sense in shipped code. If either ever
 * appears under `src/`, that is the bug — not this file.
 */
interface ImportMeta {
  glob<T = unknown>(
    patterns: string | string[],
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, T>;
}
