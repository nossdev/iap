/**
 * Single source of truth for the versioned-docs navigation.
 *
 * Imported by BOTH `config.ts` (which seeds `themeConfig.nav`) and
 * `theme/Layout.vue` (which re-derives the nav per route at runtime). They must
 * agree: `Layout.vue` overwrites `themeConfig.nav` on every render, so anything
 * defined only in `config.ts` is dead code. Keeping the table here is what stops
 * the two from drifting — a rollover that updated `config.ts` alone previously
 * shipped a switcher that still advertised the *previous* major and omitted the
 * newly archived one entirely.
 *
 * ROLLOVER RECIPE (at each Capacitor major, e.g. 8 → 9):
 *   1. Snapshot the live docs into `docs/v<N>/` (see docs/v7 for the shape).
 *   2. Add a `/v<N>/…` sidebar block in `config.ts` (copy the `/v7/` block).
 *   3. Insert `{ prefix: '/v<N>', … }` into VERSIONS below, after the current
 *      line, and relabel the `''` entry to the new current major.
 * `prefix: ''` is always the current line and MUST stay first.
 */

export interface DocsVersion {
  /** Route prefix. `''` is the current line, served from the site root. */
  readonly prefix: string;
  /** Dropdown trigger text shown while reading this version. */
  readonly trigger: string;
  /** Label for this version inside the dropdown. */
  readonly label: string;
  /** Where the dropdown entry navigates to (the version's index). */
  readonly link: string;
}

export const VERSIONS: readonly DocsVersion[] = [
  { prefix: '', trigger: 'next', label: 'next (v8)', link: '/' },
  { prefix: '/v7', trigger: 'v7', label: 'v7 (Capacitor 7)', link: '/v7/' },
  { prefix: '/v5', trigger: 'v5', label: 'v5 (Capacitor 5)', link: '/v5/' },
] as const;

/**
 * Resolve which docs version a route belongs to. Falls back to the current
 * line (`prefix: ''`), which is why that entry must be first.
 */
export function activeVersion(path: string): DocsVersion {
  return (
    VERSIONS.find((v) => v.prefix !== '' && path.startsWith(`${v.prefix}/`)) ??
    VERSIONS[0]
  );
}

/**
 * Build the top-nav for a route. "Guide / Recipes / API" stay inside the
 * version being read; "Migration" always points at the canonical page on the
 * current line, which owns every upgrade path.
 */
export function buildNav(path: string) {
  const active = activeVersion(path);
  const prefix = active.prefix;

  return [
    {
      text: 'Guide',
      link: `${prefix}/guide/getting-started`,
      activeMatch: `${prefix}/guide/`,
    },
    {
      text: 'Recipes',
      link: `${prefix}/recipes/vue-quasar`,
      activeMatch: `${prefix}/recipes/`,
    },
    { text: 'API', link: `${prefix}/api/`, activeMatch: `${prefix}/api/` },
    { text: 'Migration', link: '/migration/', activeMatch: '/migration/' },
    {
      text: active.trigger,
      items: [
        {
          text: 'Version',
          items: VERSIONS.map((v) => ({ text: v.label, link: v.link })),
        },
        {
          text: 'Resources',
          items: [
            {
              text: 'Changelog',
              link: 'https://github.com/nossdev/iap/blob/main/CHANGELOG.md',
            },
            {
              text: 'npm',
              link: 'https://www.npmjs.com/package/@nosslabs/iap',
            },
          ],
        },
      ],
    },
  ];
}
