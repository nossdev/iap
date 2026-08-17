import { describe, expect, it } from 'vitest';
import { version as packageVersion } from '../../package.json';
import { VERSION } from '../../src/version.js';

describe('VERSION', () => {
  // NOTE ON WHAT THIS DOES AND DOES NOT PROVE.
  //
  // Both sides of this assertion derive from the same package.json: vitest.config.ts
  // sets `__PKG_VERSION__` from it, and the test imports `version` from it. So this
  // cannot catch drift in the *shipped* artifact — it only fails if the vitest
  // `define` is missing entirely (ReferenceError).
  //
  // The real guard for the published bundle is the dist assertion in ci.yml and
  // release.yml, which imports dist/index.{js,cjs} and compares VERSION against
  // package.json. Without that, deleting the `define` in tsup.config.ts would ship
  // a package that throws `__PKG_VERSION__ is not defined` on import, through a
  // fully green typecheck/lint/test/build pipeline.
  it('matches the version in package.json', () => {
    expect(VERSION).toBe(packageVersion);
  });

  it('is a non-empty semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
