/**
 * Assert the built artifact keeps the optional peers out of its top-level
 * imports.
 *
 * This is the property the lazy-`import()` work exists for, and no unit test
 * can see it: a static import and a dynamic one behave identically at
 * runtime, and differ only in what the bundler hoists. The source sweep in
 * `tests/unit/storage-lazy-preferences.test.ts` is a good proxy; this checks
 * the thing we actually publish.
 *
 * Runs after `build`, so it reads a fresh `dist/`.
 */
import { readFileSync } from 'node:fs';

/** Packages that must never be reached from the top of the bundle. */
const OPTIONAL_PEERS = ['@capacitor/preferences', '@capacitor/app'];

const TARGETS = [
  { file: 'dist/index.js', kind: 'esm' },
  { file: 'dist/index.cjs', kind: 'cjs' },
];

const problems = [];

for (const { file, kind } of TARGETS) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (cause) {
    problems.push(`${file} is missing — run \`npm run build\` first (${cause.message})`);
    continue;
  }

  for (const peer of OPTIONAL_PEERS) {
    // ESM: `import … from '<peer>'` / `import '<peer>'` at the start of a
    // line. CJS: `require('<peer>')`. A dynamic `import('<peer>')` is the
    // shape we want and matches neither.
    const escaped = peer.replace(/[/\-]/g, (c) => `\\${c}`);
    const statik =
      kind === 'esm'
        ? new RegExp(`^\\s*import\\s[^;]*?['"\`]${escaped}['"\`]`, 'm')
        : new RegExp(`(?<!\\bimport\\s*\\(\\s*)require\\(\\s*['"\`]${escaped}['"\`]`);

    if (statik.test(source)) {
      problems.push(
        `${file} reaches ${peer} statically. It is an optional peer and must be loaded with await import(), or every consumer ships the native plugin.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('Bundle check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `Bundle check passed: ${OPTIONAL_PEERS.join(', ')} are not statically imported by dist/index.js or dist/index.cjs.`,
);
