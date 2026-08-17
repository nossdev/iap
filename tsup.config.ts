import { defineConfig } from 'tsup';
import { version } from './package.json';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  treeshake: true,
  minify: false,
  define: {
    __PKG_VERSION__: JSON.stringify(version),
  },
  outExtension({ format }) {
    return format === 'cjs' ? { js: '.cjs' } : { js: '.js' };
  },
});
