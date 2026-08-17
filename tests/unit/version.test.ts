import { describe, expect, it } from 'vitest';
import { version as packageVersion } from '../../package.json';
import { VERSION } from '../../src/version.js';

describe('VERSION', () => {
  // Guards the drift that shipped 0.1.0 to consumers while package.json was
  // several majors ahead: VERSION is publicly re-exported and the logger
  // stamps it onto error reports, so a stale value silently misattributes
  // every bug report.
  it('matches the version in package.json', () => {
    expect(VERSION).toBe(packageVersion);
  });

  it('is a non-empty semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
