import { defineConfig } from 'vitepress';

export default defineConfig({
  title: '@nosslabs/iap',
  description:
    'Thin Capacitor IAP orchestrator that pairs with Attesto for server-side receipt validation.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  // Internal recon docs (plugin-v7-api.md) are engineering notes; keep them
  // out of the public site.
  srcExclude: ['internal/**', '**/README.md'],

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: '@nosslabs/iap' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'In-app purchases for Capacitor 7+ with server-side validation via Attesto.',
      },
    ],
    ['meta', { property: 'og:url', content: 'https://iap.nossdev.com/' }],
  ],

  themeConfig: {
    logo: '/iap-logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Recipes', link: '/recipes/vue-quasar', activeMatch: '/recipes/' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      { text: 'Migration', link: '/migration/', activeMatch: '/migration/' },
      {
        // Version switcher. "next" = the in-dev latest Capacitor major (today
        // v7, prerelease on `@next`); older Capacitor majors are pinned by
        // number. The label stays "next" intentionally — it mirrors the npm
        // dist-tag and rotates meaning (v7 today → v8 when Cap-8 dev starts).
        // The page-path is NOT preserved across versions; clicking lands on
        // the chosen version's index. See the "Versioning + branch model"
        // memory for the rollover recipe.
        text: 'next',
        items: [
          {
            text: 'Version',
            items: [
              { text: 'next (v7)', link: '/' },
              { text: 'v5 (Capacitor 5)', link: '/v5/' },
            ],
          },
          {
            text: 'Resources',
            items: [
              { text: 'Changelog', link: 'https://github.com/nossdev/iap/blob/main/CHANGELOG.md' },
              { text: 'npm', link: 'https://www.npmjs.com/package/@nosslabs/iap' },
            ],
          },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is @nosslabs/iap?', link: '/guide/' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Concepts',
          items: [
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Safety guarantees', link: '/guide/safety-guarantees' },
            { text: 'Backend contract', link: '/guide/backend-contract' },
            { text: 'Events', link: '/guide/events' },
            { text: 'Error handling', link: '/guide/error-handling' },
          ],
        },
        {
          text: 'Operations',
          items: [{ text: 'Testing on sandbox', link: '/guide/testing' }],
        },
      ],
      '/recipes/': [
        {
          text: 'Frameworks',
          items: [
            { text: 'Vue + Quasar', link: '/recipes/vue-quasar' },
            { text: 'React', link: '/recipes/react' },
            { text: 'Pinia store', link: '/recipes/pinia-store' },
          ],
        },
        {
          text: 'Patterns',
          items: [{ text: 'Optimistic grant', link: '/recipes/optimistic-grant' }],
        },
      ],
      '/api/': [
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'createIAP()', link: '/api/create-iap' },
            { text: 'IAP instance', link: '/api/iap-instance' },
            { text: 'Types', link: '/api/types' },
            { text: 'Errors', link: '/api/errors' },
            { text: 'BackendAdapter', link: '/api/backend-adapter' },
            { text: 'Events reference', link: '/api/events-reference' },
          ],
        },
      ],
      '/migration/': [
        {
          text: 'Migration',
          items: [{ text: '5.x (Cap 5) → 7.x (Cap 7+)', link: '/migration/' }],
        },
      ],

      // ─── v5 (Capacitor 5) docs — frozen snapshot of the 5.x branch ───
      // Mirrors the structure above but with /v5/ prefixes. Maintained
      // manually; cherry-pick from the 5.x branch when a doc fix lands
      // there. The Cap-5 line is in maintenance, so churn is rare.
      '/v5/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is @nosslabs/iap?', link: '/v5/guide/' },
            { text: 'Getting started', link: '/v5/guide/getting-started' },
            { text: 'Installation', link: '/v5/guide/installation' },
            { text: 'Configuration', link: '/v5/guide/configuration' },
          ],
        },
        {
          text: 'Concepts',
          items: [
            { text: 'Architecture', link: '/v5/guide/architecture' },
            { text: 'Safety guarantees', link: '/v5/guide/safety-guarantees' },
            { text: 'Backend contract', link: '/v5/guide/backend-contract' },
            { text: 'Events', link: '/v5/guide/events' },
            { text: 'Error handling', link: '/v5/guide/error-handling' },
          ],
        },
        {
          text: 'Operations',
          items: [{ text: 'Testing on sandbox', link: '/v5/guide/testing' }],
        },
      ],
      '/v5/recipes/': [
        {
          text: 'Frameworks',
          items: [
            { text: 'Vue + Quasar', link: '/v5/recipes/vue-quasar' },
            { text: 'React', link: '/v5/recipes/react' },
            { text: 'Pinia store', link: '/v5/recipes/pinia-store' },
          ],
        },
        {
          text: 'Patterns',
          items: [{ text: 'Optimistic grant', link: '/v5/recipes/optimistic-grant' }],
        },
      ],
      '/v5/api/': [
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/v5/api/' },
            { text: 'createIAP()', link: '/v5/api/create-iap' },
            { text: 'IAP instance', link: '/v5/api/iap-instance' },
            { text: 'Types', link: '/v5/api/types' },
            { text: 'Errors', link: '/v5/api/errors' },
            { text: 'BackendAdapter', link: '/v5/api/backend-adapter' },
            { text: 'Events reference', link: '/v5/api/events-reference' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/nossdev/iap' }],

    editLink: {
      pattern: 'https://github.com/nossdev/iap/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message:
        'Released under the MIT License. Pairs with <a href="https://attesto.nossdev.com">Attesto</a> for server-side receipt validation.',
      copyright: 'Copyright © 2026 nossdev',
    },

    outline: { level: [2, 3] },
  },
});
